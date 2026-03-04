use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as Base64Engine;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use scap::frame::convert_bgra_to_rgb;
use scap::{Capturer, Frame, FrameType, Options, Resolution, Target, VideoFrame};
use tauri::{State, Window};

#[derive(Default)]
pub struct CaptureState {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
    handle: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(serde::Serialize)]
struct FramePayload {
    data: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub fn start_native_capture(
    window: Window,
    state: State<CaptureState>,
    fps: Option<u32>,
    quality: Option<u8>,
) -> Result<(), String> {
    let mut handle_guard = state.handle.lock().map_err(|_| "lock")?;
    if handle_guard.is_some() {
        return Ok(());
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let mut stop_guard = state.stop_flag.lock().map_err(|_| "lock")?;
        *stop_guard = Some(stop_flag.clone());
    }

    let requested_fps = fps.unwrap_or(15).clamp(5, 60);
    let jpeg_quality = quality.unwrap_or(60).clamp(30, 90);
    let window_clone = window.clone();

    *handle_guard = Some(thread::spawn(move || {
        if !scap::is_supported() {
            let _ = window_clone.emit("native_capture_error", "not_supported");
            return;
        }
        if !scap::has_permission() && !scap::request_permission() {
            let _ = window_clone.emit("native_capture_error", "permission_denied");
            return;
        }

        let target = if cfg!(target_os = "linux") {
            None
        } else {
            Some(Target::Display(scap::get_main_display()))
        };

        let options = Options {
            fps: requested_fps,
            show_cursor: true,
            show_highlight: false,
            target,
            crop_area: None,
            output_type: FrameType::BGRAFrame,
            output_resolution: Resolution::Captured,
            excluded_targets: None,
            captures_audio: false,
            exclude_current_process_audio: false,
        };

        let mut capturer = match Capturer::build(options) {
            Ok(capturer) => capturer,
            Err(err) => {
                let _ = window_clone.emit("native_capture_error", format!("init_error:{err}"));
                return;
            }
        };

        capturer.start_capture();

        while !stop_flag.load(Ordering::Relaxed) {
            match capturer.get_next_frame() {
                Ok(frame) => {
                    if let Some((rgb, width, height)) = map_frame(frame) {
                        let mut buffer = Vec::new();
                        let mut encoder = JpegEncoder::new_with_quality(&mut buffer, jpeg_quality);
                        if encoder
                            .encode(&rgb, width, height, ColorType::Rgb8)
                            .is_ok()
                        {
                            let encoded = Base64Engine.encode(buffer);
                            let _ = window_clone.emit(
                                "native_capture_frame",
                                FramePayload {
                                    data: encoded,
                                    width,
                                    height,
                                },
                            );
                        }
                    }
                }
                Err(_) => {
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }

        capturer.stop_capture();
    }));

    Ok(())
}

#[tauri::command]
pub fn stop_native_capture(state: State<CaptureState>) -> Result<(), String> {
    if let Ok(mut stop_guard) = state.stop_flag.lock() {
        if let Some(flag) = stop_guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
        *stop_guard = None;
    }

    if let Ok(mut handle_guard) = state.handle.lock() {
        if let Some(handle) = handle_guard.take() {
            let _ = handle.join();
        }
    }

    Ok(())
}

fn map_frame(frame: Frame) -> Option<(Vec<u8>, u32, u32)> {
    match frame {
        Frame::Video(VideoFrame::BGRA(frame)) => {
            let width = frame.width as u32;
            let height = frame.height as u32;
            let rgb = convert_bgra_to_rgb(frame.data);
            Some((rgb, width, height))
        }
        _ => None,
    }
}
