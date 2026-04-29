use std::{cell::UnsafeCell, ffi::c_void, os::raw::c_int, slice, time::Duration};

use moonlight_common_sys::limelight::{_DECODER_RENDERER_CALLBACKS, PDECODE_UNIT};
use num::FromPrimitive;

use crate::stream::bindings::{
    BufferType, Capabilities, Colorspace, DecodeResult, FrameType, SupportedVideoFormats,
    VideoDataBuffer, VideoDecodeUnit, VideoFormat,
};

pub trait VideoDecoder {
    /// This callback is invoked to provide details about the video stream and allow configuration of the decoder.
    /// Returns 0 on success, non-zero on failure.
    fn setup(
        &mut self,
        format: VideoFormat,
        width: u32,
        height: u32,
        redraw_rate: u32,
        flags: i32,
    ) -> i32;

    /// This callback notifies the decoder that the stream is starting. No frames can be submitted before this callback returns.
    fn start(&mut self);

    /// This callback provides Annex B formatted elementary stream data to the
    /// decoder. If the decoder is unable to process the submitted data for some reason,
    /// it must return DR_NEED_IDR to generate a keyframe.
    fn submit_decode_unit(&mut self, unit: VideoDecodeUnit<'_>) -> DecodeResult;

    /// This callback notifies the decoder that the stream is stopping. Frames may still be submitted but they may be safely discarded.
    fn stop(&mut self);

    fn supported_formats(&self) -> SupportedVideoFormats;
    fn capabilities(&self) -> Capabilities {
        Capabilities::empty()
    }
}

// SAFETY: moonlight-common-c guarantees that video decoder callbacks are invoked
// from a single thread. set_global/clear_global are synchronized by the connection
// lock in mod.rs. This eliminates a Mutex lock/unlock on every video frame.
struct UnsyncVideoDecoder(UnsafeCell<Option<Box<dyn VideoDecoder + Send + 'static>>>);
unsafe impl Sync for UnsyncVideoDecoder {}

static GLOBAL_VIDEO_DECODER: UnsyncVideoDecoder =
    UnsyncVideoDecoder(UnsafeCell::new(None));

fn global_decoder<R>(f: impl FnOnce(&mut dyn VideoDecoder) -> R) -> R {
    // SAFETY: Only called from the single moonlight-common-c video callback thread
    // between set_global() and clear_global(), which are externally synchronized.
    let decoder = unsafe { &mut *GLOBAL_VIDEO_DECODER.0.get() };
    let decoder = decoder.as_mut().expect("global video decoder");
    f(decoder.as_mut())
}

pub(crate) fn set_global(decoder: impl VideoDecoder + Send + 'static) {
    // SAFETY: Called while holding the connection lock, before callbacks start
    unsafe {
        *GLOBAL_VIDEO_DECODER.0.get() = Some(Box::new(decoder));
    }
}
pub(crate) fn clear_global() {
    // SAFETY: Called while holding the connection lock, after callbacks stop
    unsafe {
        *GLOBAL_VIDEO_DECODER.0.get() = None;
    }
}

#[allow(non_snake_case)]
unsafe extern "C" fn setup(
    videoFormat: c_int,
    width: c_int,
    height: c_int,
    redrawRate: c_int,
    _context: *mut c_void,
    drFlags: c_int,
) -> c_int {
    global_decoder(|decoder| {
        decoder.setup(
            VideoFormat::from_i32(videoFormat).expect("invalid video format"),
            width as u32,
            height as u32,
            redrawRate as u32,
            drFlags,
        )
    })
}
unsafe extern "C" fn start() {
    global_decoder(|decoder| {
        decoder.start();
    })
}

// SAFETY: Same single-thread guarantee as GLOBAL_VIDEO_DECODER above.
struct UnsyncBuffer(UnsafeCell<Vec<VideoDataBuffer<'static>>>);
unsafe impl Sync for UnsyncBuffer {}

static BUFFER: UnsyncBuffer = UnsyncBuffer(UnsafeCell::new(Vec::new()));

unsafe extern "C" fn submit_decode_unit(decode_unit: PDECODE_UNIT) -> c_int {
    let raw = unsafe { *decode_unit };

    // SAFETY: Only accessed from the single video callback thread.
    let buffers = unsafe { &mut *BUFFER.0.get() };
    buffers.clear();

    let mut next_element_ptr = raw.bufferList;
    while !next_element_ptr.is_null() {
        unsafe {
            let element_raw = *next_element_ptr;

            // # Safety
            // The element currently has 'static but thats okay
            // -> Look at the buffer safety
            let new_element = VideoDataBuffer {
                ty: BufferType::from_i32(element_raw.bufferType).expect("valid buffer type"),
                data: slice::from_raw_parts(
                    element_raw.data as *const u8,
                    element_raw.length as usize,
                ),
            };
            buffers.push(new_element);

            next_element_ptr = element_raw.next;
        }
    }

    let unit = VideoDecodeUnit {
        frame_number: raw.frameNumber,
        frame_type: FrameType::from_i32(raw.frameType).expect("valid FrameType"),
        frame_processing_latency: if raw.frameHostProcessingLatency == 0 {
            None
        } else {
            Some(Duration::from_millis(
                (raw.frameHostProcessingLatency * 10) as u64,
            ))
        },
        receive_time: Duration::from_millis(raw.receiveTimeMs),
        enqueue_time: Duration::from_millis(raw.enqueueTimeMs),
        presentation_time: Duration::from_millis(raw.presentationTimeMs as u64),
        color_space: Colorspace::from_u8(raw.colorspace).expect("valid Colorspace"),
        hdr_active: raw.hdrActive,
        buffers: &buffers,
    };

    let result = global_decoder(|decoder| decoder.submit_decode_unit(unit) as i32);

    buffers.clear();

    result
}

unsafe extern "C" fn stop() {
    global_decoder(|decoder| {
        decoder.stop();
    })
}

unsafe extern "C" fn cleanup() {
    clear_global();
}

pub(crate) unsafe fn raw_callbacks() -> _DECODER_RENDERER_CALLBACKS {
    let capabilities = global_decoder(|decoder| decoder.capabilities());

    _DECODER_RENDERER_CALLBACKS {
        setup: Some(setup),
        start: Some(start),
        stop: Some(stop),
        cleanup: Some(cleanup),
        submitDecodeUnit: Some(submit_decode_unit),
        capabilities: capabilities.bits() as i32,
    }
}
