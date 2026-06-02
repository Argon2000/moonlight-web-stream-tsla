use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};

use log::warn;
use tokio::sync::{
    mpsc::{Receiver, Sender, channel},
};
use webrtc::{
    media::Sample,
    rtcp::packet::Packet,
    rtp::{
        self,
        extension::HeaderExtension,
    },
    rtp_transceiver::rtp_sender::RTCRtpSender,
    track::track_local::{
        TrackLocal, track_local_static_rtp::TrackLocalStaticRTP,
        track_local_static_sample::TrackLocalStaticSample,
    },
};

use crate::StreamConnection;

pub struct TrackLocalSender<Track>
where
    Track: TrackLike,
{
    channel_queue_size: usize,
    pub(crate) stream: Arc<StreamConnection>,
    sender: Option<Sender<Track::Sample>>,
}

impl<Track> TrackLocalSender<Track>
where
    Track: TrackLike,
{
    pub fn new(stream: Arc<StreamConnection>, channel_queue_size: usize) -> Self {
        Self {
            channel_queue_size,
            stream,
            sender: Default::default(),
        }
    }

    pub fn blocking_create_track(
        &mut self,
        track: Track,
        mut on_packet: impl FnMut(Box<dyn Packet + Send + Sync>) + Send + 'static,
    ) -> Result<(), anyhow::Error> {
        let stream = self.stream.clone();

        let track = Arc::new(track);

        let (sender, receiver) = channel(self.channel_queue_size);

        self.stream.runtime.spawn({
            let track = track.clone();
            async move {
                sample_sender(track, receiver).await;
            }
        });

        let track_sender = self.stream.runtime.block_on({
            let track = track.clone();
            async move { stream.peer.add_track(track.track()).await }
        })?;

        // Read incoming RTCP packets.
        // Before these packets are returned they are processed by interceptors. For things
        // like NACK this needs to be called.
        self.stream.runtime.spawn(async move {
            let mut rtcp_buf = vec![0u8; 1500];
            while let Ok((packets, _)) = track_sender.read(&mut rtcp_buf).await {
                for packet in packets {
                    on_packet(packet);
                }
            }
        });

        self.sender.replace(sender);

        Ok(())
    }

    pub fn blocking_send_sample(&self, sample: Track::Sample) {
        if let Some(sender) = self.sender.as_ref() {
            let _ = sender.blocking_send(sample);
        }
    }
}

impl TrackLocalSender<SequencedTrackLocalStaticRTP> {
    /// Activate the sender by replacing the track on an existing transceiver sender.
    /// This is codec-agnostic: the transceiver was added with all codecs in the SDP,
    /// and we now attach the track for whichever codec Moonlight actually selected.
    /// No renegotiation is triggered.
    pub fn blocking_activate_via_replace_track(
        &mut self,
        track: Arc<TrackLocalStaticRTP>,
        rtp_sender: Arc<RTCRtpSender>,
        mut on_packet: impl FnMut(Box<dyn Packet + Send + Sync>) + Send + 'static,
    ) -> Result<(), anyhow::Error> {
        let sequenced = Arc::new(SequencedTrackLocalStaticRTP::from_arc(track.clone()));

        // Attach the track to the pre-existing transceiver sender.
        // The inner TrackLocalStaticRTP is what pion binds to its interceptor chain.
        self.stream.runtime.block_on(
            rtp_sender.replace_track(Some(sequenced.track.clone()))
        )?;

        let (sender, receiver) = channel(self.channel_queue_size);

        self.stream.runtime.spawn({
            let track = sequenced.clone();
            async move {
                sample_sender(track, receiver).await;
            }
        });

        self.stream.runtime.spawn(async move {
            let mut rtcp_buf = vec![0u8; 1500];
            while let Ok((packets, _)) = rtp_sender.read(&mut rtcp_buf).await {
                for packet in packets {
                    on_packet(packet);
                }
            }
        });

        self.sender.replace(sender);
        Ok(())
    }
}

async fn sample_sender<Track>(track: Arc<Track>, mut receiver: Receiver<Track::Sample>)
where
    Track: TrackLike,
{
    // We do NOT send the PlayoutDelayExtension.
    // Setting it to (0, 0) disables WebRTC's adaptive jitter buffer, causing severe frame drops
    // on cellular networks with 20ms+ latency jitter. Letting the browser manage its own jitter
    // buffer is essential for smooth real-time streaming over variable networks.
    let extensions = [];
    while let Some(sample) = receiver.recv().await {
        if let Err(err) = track
            .write_with_extensions(
                sample,
                &extensions,
            )
            .await
        {
            warn!("[Stream]: track.write_sample failed: {err}");
        }
    }
}

pub trait TrackLike: Send + Sync + 'static {
    type Sample: Send + 'static;

    fn write_with_extensions(
        &self,
        sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> impl Future<Output = Result<(), anyhow::Error>> + Send;

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static>;
}

impl TrackLike for TrackLocalStaticSample {
    type Sample = Sample;

    async fn write_with_extensions(
        &self,
        sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> Result<(), anyhow::Error> {
        self.write_sample_with_extensions(&sample, extensions)
            .await
            .map_err(anyhow::Error::from)
    }

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static> {
        self
    }
}

pub struct SequencedTrackLocalStaticRTP {
    track: Arc<TrackLocalStaticRTP>,
    sequence_number: AtomicU16,
}

impl From<TrackLocalStaticRTP> for SequencedTrackLocalStaticRTP {
    fn from(value: TrackLocalStaticRTP) -> Self {
        Self {
            track: Arc::new(value),
            sequence_number: AtomicU16::new(0),
        }
    }
}

impl SequencedTrackLocalStaticRTP {
    pub(crate) fn from_arc(track: Arc<TrackLocalStaticRTP>) -> Self {
        Self {
            track,
            sequence_number: AtomicU16::new(0),
        }
    }
}

impl TrackLike for SequencedTrackLocalStaticRTP {
    type Sample = rtp::packet::Packet;

    async fn write_with_extensions(
        &self,
        mut sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> Result<(), anyhow::Error> {
        let (any_paused, all_paused) = (
            self.track.any_binding_paused().await,
            self.track.all_binding_paused().await,
        );

        if all_paused {
            // Abort already here to not increment sequence numbers.
            return Ok(());
        }
        if any_paused {
            // TODO: maybe warn?
        }

        sample.header.sequence_number = self.sequence_number.fetch_add(1, Ordering::Relaxed);

        self.track
            .write_rtp_with_extensions(&sample, extensions)
            .await
            .map_err(anyhow::Error::from)
            .map(|_| ())
    }

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static> {
        self.track.clone()
    }
}
