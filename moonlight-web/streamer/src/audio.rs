use std::io::Write;
use std::sync::Arc;

use bytes::Bytes;
use log::{info, warn};
use moonlight_common::stream::{
    audio::AudioDecoder,
    bindings::{AudioConfig, OpusMultistreamConfig},
};
use ogg::{PacketWriteEndInfo, PacketWriter};
use tokio::sync::mpsc::{self, Sender, UnboundedSender};
use webrtc::{
    api::media_engine::{MIME_TYPE_OPUS, MediaEngine},
    data_channel::RTCDataChannel,
    rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
};

pub fn register_audio_codecs(media_engine: &mut MediaEngine) -> Result<(), webrtc::Error> {
    media_engine.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48000,
                channels: 2,
                sdp_fmtp_line: "minptime=20;useinbandfec=1;maxaveragebitrate=128000".to_owned(),
                rtcp_feedback: vec![],
            },
            payload_type: 111,
            ..Default::default()
        },
        RTPCodecType::Audio,
    )?;

    Ok(())
}

pub struct OpusTrackSampleAudioDecoder {
    channel: Arc<RTCDataChannel>,
    sender: Option<Sender<Bytes>>,
    config: Option<OpusMultistreamConfig>,
}

impl OpusTrackSampleAudioDecoder {
    pub fn new(channel: Arc<RTCDataChannel>) -> Self {
        Self {
            channel,
            sender: None,
            config: None,
        }
    }
}

struct VecSender(UnboundedSender<Vec<u8>>);
impl Write for VecSender {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .send(buf.to_vec())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl AudioDecoder for OpusTrackSampleAudioDecoder {
    fn setup(
        &mut self,
        audio_config: AudioConfig,
        stream_config: OpusMultistreamConfig,
        _ar_flags: i32,
    ) -> i32 {
        info!("[Stream] Audio setup: {audio_config:?}, {stream_config:?}");

        const SUPPORTED_SAMPLE_RATES: &[u32] = &[80000, 12000, 16000, 24000, 48000];
        if !SUPPORTED_SAMPLE_RATES.contains(&stream_config.sample_rate) {
            warn!(
                "[Stream] Audio could have problems because of the sample rate, Selected: {}, Expected one of: {SUPPORTED_SAMPLE_RATES:?}",
                stream_config.sample_rate
            );
        }
        if audio_config != self.config() {
            warn!(
                "[Stream] A different audio configuration than requested was selected, Expected: {:?}, Found: {audio_config:?}",
                self.config()
            );
        }

        let samples_per_frame = stream_config.samples_per_frame as u64;
        self.config = Some(stream_config);

        let (sender, mut receiver) = mpsc::channel::<Bytes>(50);
        self.sender = Some(sender);

        let channel = self.channel.clone();

        tokio::spawn(async move {
            let (chunk_tx, mut chunk_rx) = mpsc::unbounded_channel();
            let mut writer = PacketWriter::new(VecSender(chunk_tx));
            let serial = 12345;
            let mut granule_pos = 0;

            // Write ID Header
            let mut id_header = Vec::new();
            id_header.extend_from_slice(b"OpusHead");
            id_header.push(1); // Version
            id_header.push(2); // Channels
            id_header.extend_from_slice(&0u16.to_le_bytes()); // Pre-skip
            id_header.extend_from_slice(&48000u32.to_le_bytes()); // Sample rate
            id_header.extend_from_slice(&0u16.to_le_bytes()); // Gain
            id_header.push(0); // Mapping family

            if let Err(e) = writer.write_packet(
                id_header,
                serial,
                PacketWriteEndInfo::EndPage,
                granule_pos,
            ) {
                warn!("Failed to write ID header: {:?}", e);
            }

            // Write Comment Header
            let mut comment_header = Vec::new();
            comment_header.extend_from_slice(b"OpusTags");
            let vendor = "Moonlight";
            comment_header.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
            comment_header.extend_from_slice(vendor.as_bytes());
            comment_header.extend_from_slice(&0u32.to_le_bytes()); // User comment list length

            if let Err(e) = writer.write_packet(
                comment_header,
                serial,
                PacketWriteEndInfo::EndPage,
                granule_pos,
            ) {
                warn!("Failed to write comment header: {:?}", e);
            }

            // Send headers
            while let Ok(chunk) = chunk_rx.try_recv() {
                if let Err(e) = channel.send(&Bytes::from(chunk)).await {
                    warn!("Failed to send Ogg headers: {:?}", e);
                }
            }

            while let Some(data) = receiver.recv().await {
                granule_pos += samples_per_frame;

                if let Err(e) = writer.write_packet(
                    data.to_vec(),
                    serial,
                    PacketWriteEndInfo::EndPage,
                    granule_pos,
                ) {
                    warn!("Failed to write audio packet: {:?}", e);
                }

                while let Ok(chunk) = chunk_rx.try_recv() {
                    if let Err(e) = channel.send(&Bytes::from(chunk)).await {
                        warn!("Failed to send audio data: {:?}", e);
                    }
                }
            }
        });

        0
    }

    fn start(&mut self) {}

    fn stop(&mut self) {}

    fn decode_and_play_sample(&mut self, data: &[u8]) {
        if let Some(sender) = &self.sender {
            let data = Bytes::copy_from_slice(data);
            let _ = sender.blocking_send(data);
        }
    }

    fn config(&self) -> AudioConfig {
        AudioConfig::STEREO
    }
}
