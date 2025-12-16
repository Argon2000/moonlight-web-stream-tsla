use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use bytes::Bytes;
use log::{debug, error, info, warn};
use moonlight_common::stream::{
    bindings::{DecodeResult, SupportedVideoFormats, VideoDecodeUnit, VideoFormat},
    video::VideoDecoder,
};
use webrtc::{
    api::media_engine::{MIME_TYPE_AV1, MIME_TYPE_H264, MIME_TYPE_HEVC, MediaEngine},
    rtcp::payload_feedbacks::{
        picture_loss_indication::PictureLossIndication,
        receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate,
    },
    rtp::{
        codecs::{av1::Av1Payloader, h265::RTP_OUTBOUND_MTU},
        header::Header,
        packet::Packet,
        packetizer::Payloader,
    },
    rtp_transceiver::{
        RTCPFeedback,
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
    },
    track::track_local::track_local_static_rtp::TrackLocalStaticRTP,
};

use crate::{
    StreamConnection,
    sender::{SequencedTrackLocalStaticRTP, TrackLocalSender},
    video::{
        annexb::AnnexBSplitter,
        h264::{payloader::H264Payloader, reader::H264Reader},
        h265::{payloader::H265Payloader, reader::H265Reader},
    },
};

mod annexb;
mod h264;
mod h265;

pub fn register_video_codecs(
    media_engine: &mut MediaEngine,
    supported_video_formats: SupportedVideoFormats,
) -> Result<(), webrtc::Error> {
    for format in VideoFormat::all() {
        if !format.contained_in(supported_video_formats) {
            continue;
        }

        let Some(codec) = video_format_to_codec(format) else {
            continue;
        };
        debug!(
            "Registering Video Format {format:?}, Codec: {:?}",
            codec.capability
        );

        media_engine.register_codec(codec, RTPCodecType::Video)?;
    }

    Ok(())
}

enum VideoCodec {
    H264 {
        nal_reader: H264Reader,
        payloader: H264Payloader,
    },
    H265 {
        nal_reader: H265Reader,
        payloader: H265Payloader,
    },
    Av1 {
        annex_b: AnnexBSplitter,
        payloader: Av1Payloader,
    },
}

pub struct TrackSampleVideoDecoder {
    sender: TrackLocalSender<SequencedTrackLocalStaticRTP>,
    clock_rate: u32,
    supported_formats: SupportedVideoFormats,
    // Video important
    video_codec: Option<VideoCodec>,
    samples: Vec<Bytes>,
    needs_idr: Arc<AtomicBool>,
    old_presentation_time: Duration,
}

impl TrackSampleVideoDecoder {
    pub fn new(
        stream: Arc<StreamConnection>,
        supported_formats: SupportedVideoFormats,
        channel_queue_size: usize,
    ) -> Self {
        Self {
            sender: TrackLocalSender::new(stream, channel_queue_size),
            clock_rate: 0,
            supported_formats,
            video_codec: None,
            samples: Vec::new(),
            needs_idr: Default::default(),
            old_presentation_time: Duration::ZERO,
        }
    }

    fn send_single_frame(
        samples: &mut Vec<Bytes>,
        sender: &mut TrackLocalSender<SequencedTrackLocalStaticRTP>,
        payloader: &mut impl Payloader,
        timestamp: u32,
    ) {
        let mut peekable = samples.drain(..).peekable();
        while let Some(sample) = peekable.next() {
            let packets = match packetize(
                payloader,
                RTP_OUTBOUND_MTU,
                0, // is set in the write fn
                timestamp,
                &sample,
                peekable.peek().is_none(),
            ) {
                Ok(value) => value,
                Err(err) => {
                    warn!("failed to packetize packet: {err:?}");
                    continue;
                }
            };

            for packet in packets {
                sender.blocking_send_sample(packet);
            }
        }
    }
}

impl VideoDecoder for TrackSampleVideoDecoder {
    fn setup(
        &mut self,
        format: VideoFormat,
        width: u32,
        height: u32,
        redraw_rate: u32,
        _flags: i32,
    ) -> i32 {
        info!("[Stream] Stream setup: {width}x{height}x{redraw_rate} and {format:?}");

        {
            let mut video_size = self.sender.stream.video_size.blocking_lock();

            *video_size = (width, height);
        }

        if !format.contained_in(self.supported_formats()) {
            error!(
                "tried to setup a video stream with a non supported video format: {format:?}, supported formats: {:?}",
                self.supported_formats().iter_names().collect::<Vec<_>>()
            );
            return -1;
        }

        let Some(codec) = video_format_to_codec(format) else {
            error!("Failed to get video codec with format {format:?}");
            return -1;
        };

        self.clock_rate = codec.capability.clock_rate;

        let needs_idr = self.needs_idr.clone();
        if let Err(err) = self.sender.blocking_create_track(
            TrackLocalStaticRTP::new(
                codec.capability.clone(),
                "video".to_string(),
                "moonlight".to_string(),
            )
            .into(),
            move |packet| {
                let packet = packet.as_any();

                if packet.is::<PictureLossIndication>() {
                    needs_idr.store(true, Ordering::Release);
                }
                if let Some(_max_bitrate) = packet.downcast_ref::<ReceiverEstimatedMaximumBitrate>()
                {
                    // Moonlight doesn't support dynamic bitrate changing :(
                }
            },
        ) {
            error!(
                "Failed to create video track with format {format:?} and codec \"{codec:?}\": {err:?}"
            );
            return -1;
        }

        match format {
            // -- H264
            VideoFormat::H264 | VideoFormat::H264High8_444 => {
                self.video_codec = Some(VideoCodec::H264 {
                    nal_reader: H264Reader::new(Bytes::new()),
                    payloader: Default::default(),
                });
            }
            // -- H265
            VideoFormat::H265
            | VideoFormat::H265Main10
            | VideoFormat::H265Rext8_444
            | VideoFormat::H265Rext10_444 => {
                self.video_codec = Some(VideoCodec::H265 {
                    nal_reader: H265Reader::new(Bytes::new()),
                    payloader: Default::default(),
                });
            }
            // -- AV1
            VideoFormat::Av1Main8
            | VideoFormat::Av1Main10
            | VideoFormat::Av1High8_444
            | VideoFormat::Av1High10_444 => {
                self.video_codec = Some(VideoCodec::Av1 {
                    annex_b: AnnexBSplitter::new(Bytes::new()),
                    payloader: Default::default(),
                });
            }
        }

        0
    }
    fn start(&mut self) {}
    fn stop(&mut self) {}

    fn submit_decode_unit(&mut self, unit: VideoDecodeUnit<'_>) -> DecodeResult {
        let timestamp = (unit.presentation_time.as_secs_f64() * self.clock_rate as f64) as u32;

        let total_len = unit.buffers.iter().map(|b| b.data.len()).sum();
        let mut full_frame = Vec::with_capacity(total_len);
        for buffer in unit.buffers {
            full_frame.extend_from_slice(buffer.data);
        }
        let full_frame_bytes = Bytes::from(full_frame);

        match &mut self.video_codec {
            // -- H264
            Some(VideoCodec::H264 {
                nal_reader,
                payloader,
            }) => {
                nal_reader.reset(full_frame_bytes);

                while let Some(nal) = nal_reader.next_nal() {
                    let data = nal.full.slice(nal.header_range.start..nal.payload_range.end);
                    self.samples.push(data);
                }

                Self::send_single_frame(&mut self.samples, &mut self.sender, payloader, timestamp);
            }
            // -- H265
            Some(VideoCodec::H265 {
                nal_reader,
                payloader,
            }) => {
                nal_reader.reset(full_frame_bytes);

                while let Some(nal) = nal_reader.next_nal() {
                    let data = nal.full.slice(nal.header_range.start..nal.payload_range.end);
                    self.samples.push(data);
                }

                Self::send_single_frame(&mut self.samples, &mut self.sender, payloader, timestamp);
            }
            // -- AV1
            Some(VideoCodec::Av1 { annex_b, payloader }) => {
                annex_b.reset(full_frame_bytes);

                while let Some(annex_b_payload) = annex_b.next() {
                    let data = annex_b_payload.full.slice(annex_b_payload.payload_range);
                    self.samples.push(data);
                }

                Self::send_single_frame(&mut self.samples, &mut self.sender, payloader, timestamp);
            }
            None => {
                // this shouldn't happen
                unreachable!()
            }
        }

        self.old_presentation_time = unit.presentation_time;

        if self
            .needs_idr
            .compare_exchange_weak(true, false, Ordering::SeqCst, Ordering::Relaxed)
            .is_ok()
        {
            return DecodeResult::NeedIdr;
        }

        DecodeResult::Ok
    }

    fn supported_formats(&self) -> SupportedVideoFormats {
        self.supported_formats
    }
}

fn packetize(
    payloader: &mut impl Payloader,
    mtu: usize,
    sequence_number: u16,
    timestamp: u32,
    payload: &Bytes,
    end_has_marker: bool,
) -> Result<Vec<Packet>, anyhow::Error> {
    let payloads = payloader.payload(mtu - 12, payload)?;
    let payloads_len = payloads.len();
    let mut packets = Vec::with_capacity(payloads_len);
    for (i, payload) in payloads.into_iter().enumerate() {
        packets.push(Packet {
            header: Header {
                version: 2,
                padding: false,
                extension: false,
                marker: end_has_marker && i == payloads_len - 1,
                sequence_number,
                timestamp,
                payload_type: 0, // Value is handled when writing
                ssrc: 0,         // Value is handled when writing
                ..Default::default()
            },
            payload,
        });
    }

    Ok(packets)
}

fn video_format_to_codec(format: VideoFormat) -> Option<RTCRtpCodecParameters> {
    let rtcp_feedback = vec![
        RTCPFeedback {
            typ: "nack".to_string(),
            parameter: "".to_string(),
        },
        RTCPFeedback {
            typ: "nack".to_string(),
            parameter: "pli".to_string(),
        },
        RTCPFeedback {
            typ: "goog-remb".to_string(),
            parameter: "".to_string(),
        },
    ];

    match format {
        // -- H264 Constrained Baseline Profile
        VideoFormat::H264 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                        .to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 96,
            ..Default::default()
        }),
        // -- H264 High Profile
        VideoFormat::H264High8_444 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032"
                        .to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 97,
            ..Default::default()
        }),

        // TODO: h265 requires resolution in the level-id field, set it based on resolution and fps
        // -- H265 Main Profile
        VideoFormat::H265 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_HEVC.to_owned(),
                clock_rate: 90000,
                channels: 0,
                // They're the same
                // sdp_fmtp_line: "profile-id=1;level-id=93;tier-flag=0;tx-mode=1".to_owned(),
                sdp_fmtp_line: "".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 98,
            ..Default::default()
        }),
        // -- H265 Main10 Profile
        VideoFormat::H265Main10 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_HEVC.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile-id=2;tier-flag=0;level-id=93;tx-mode=SRST".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 99,
            ..Default::default()
        }),
        // -- H265 RExt 4:4:4 8-bit
        VideoFormat::H265Rext8_444 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_HEVC.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile-id=4;tier-flag=0;level-id=120;tx-mode=SRST".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 100,
            ..Default::default()
        }),
        // -- H265 RExt 4:4:4 10-bit
        VideoFormat::H265Rext10_444 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_HEVC.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile-id=5;tier-flag=0;level-id=93;tx-mode=SRST".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 101,
            ..Default::default()
        }),

        // -- Av1
        VideoFormat::Av1Main8 | VideoFormat::Av1Main10 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_AV1.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile=0".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 102,
            ..Default::default()
        }),
        VideoFormat::Av1High8_444 | VideoFormat::Av1High10_444 => Some(RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_AV1.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: "profile=1".to_owned(),
                rtcp_feedback: rtcp_feedback.clone(),
            },
            payload_type: 103,
            ..Default::default()
        }),
    }
}
