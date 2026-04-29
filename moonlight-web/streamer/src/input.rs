use std::{pin::Pin, sync::Arc};

use bytes::Bytes;
use log::{debug, warn};
use moonlight_common::stream::{
    MoonlightStream,
    bindings::{
        ActiveGamepads, ControllerButtons, ControllerCapabilities, ControllerType, KeyAction,
        KeyFlags, KeyModifiers, MouseButton, MouseButtonAction, TouchEventType,
    },
};
use num::FromPrimitive;
use tokio::sync::RwLock;
use webrtc::data_channel::{RTCDataChannel, data_channel_message::DataChannelMessage};

use crate::{StreamConnection, buffer::ByteBuffer};

const DEFAULT_CONTROLLER_BUTTONS: ControllerButtons = ControllerButtons::all();
const DEFAULT_CONTROLLER_CAPABILITIES: ControllerCapabilities = ControllerCapabilities::empty();

pub struct StreamInput {
    pub(crate) active_gamepads: RwLock<ActiveGamepads>,
    controllers: RwLock<Option<Arc<RTCDataChannel>>>,
}

impl StreamInput {
    pub fn new() -> Self {
        Self {
            active_gamepads: RwLock::new(ActiveGamepads::empty()),
            controllers: Default::default(),
        }
    }

    /// Returns if this added events
    pub async fn on_data_channel(
        &self,
        connection: &Arc<StreamConnection>,
        data_channel: Arc<RTCDataChannel>,
    ) -> bool {
        debug!(
            "[Stream Input]: adding data channel: \"{}\"",
            data_channel.label()
        );
        let label = data_channel.label();

        match label {
            "mouseClicks" | "mouseAbsolute" | "mouseRelative" => {
                data_channel.on_message(Self::create_simple_handler(
                    connection.clone(),
                    Self::on_mouse_message,
                ));
                return true;
            }
            "touch" => {
                data_channel.on_message(Self::create_simple_handler(
                    connection.clone(),
                    Self::on_touch_message,
                ));
                return true;
            }
            "keyboard" => {
                data_channel.on_message(Self::create_simple_handler(
                    connection.clone(),
                    Self::on_keyboard_message,
                ));
                return true;
            }
            "controllers" => {
                let connection = connection.clone();
                data_channel.on_message(Box::new(move |message| {
                    let connection = connection.clone();

                    Box::pin(async move {
                        Self::on_controller_message(message, &connection).await;
                    })
                }));

                let mut controllers = self.controllers.write().await;
                controllers.replace(data_channel);

                return true;
            }
            _ => {}
        };

        if let Some(number) = label.strip_prefix("controller")
            && let Ok(id) = number.parse()
        {
            let connection = connection.clone();
            data_channel.on_message(Box::new(move |message| {
                let connection = connection.clone();

                Box::pin(async move {
                    Self::on_controller_input_message(id, message, &connection).await;
                })
            }));
        }

        false
    }

    #[allow(clippy::type_complexity)]
    fn create_simple_handler(
        connection: Arc<StreamConnection>,
        f: impl Fn(&MoonlightStream, DataChannelMessage) + Send + Sync + 'static,
    ) -> Box<
        dyn FnMut(DataChannelMessage) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>>
            + Send
            + Sync,
    > {
        let f = Arc::new(f);

        Box::new(move |message| {
            let connection = connection.clone();

            let f = f.clone();
            // Fast path: try_read avoids async suspend when no writer holds the lock (99.9% of the time)
            if let Ok(stream) = connection.stream.try_read() {
                if let Some(stream) = stream.as_ref() {
                    f(stream, message);
                }
                return Box::pin(async {});
            }
            Box::pin(async move {
                let stream = connection.stream.read().await;
                if let Some(stream) = stream.as_ref() {
                    f(stream, message);
                }
            })
        })
    }

    fn on_touch_message(stream: &MoonlightStream, message: DataChannelMessage) {
        let mut buffer = ByteBuffer::new(message.data);

        let event_type = match buffer.get_u8() {
            0 => TouchEventType::Down,
            1 => TouchEventType::Move,
            2 => TouchEventType::Cancel,
            _ => {
                warn!("[Stream Input]: received invalid touch event type");
                return;
            }
        };
        let pointer_id = buffer.get_u32();
        let x = buffer.get_f32();
        let y = buffer.get_f32();
        let pressure_or_distance = buffer.get_f32();
        let contact_area_major = buffer.get_f32();
        let contact_area_minor = buffer.get_f32();
        let rotation = buffer.get_u16();

        let _ = stream.send_touch(
            pointer_id,
            x,
            y,
            pressure_or_distance,
            contact_area_major,
            contact_area_minor,
            Some(rotation),
            event_type,
        );
    }

    fn on_mouse_message(stream: &MoonlightStream, message: DataChannelMessage) {
        let mut buffer = ByteBuffer::new(message.data);

        let ty = buffer.get_u8();
        if ty == 0 {
            // Move
            let delta_x = buffer.get_i16();
            let delta_y = buffer.get_i16();

            let _ = stream.send_mouse_move(delta_x, delta_y);
        } else if ty == 1 {
            // Position
            let x = buffer.get_i16();
            let y = buffer.get_i16();
            let reference_width = buffer.get_i16();
            let reference_height = buffer.get_i16();

            let _ = stream.send_mouse_position(x, y, reference_width, reference_height);
        } else if ty == 2 {
            // Button Press / Release
            let action = if buffer.get_bool() {
                MouseButtonAction::Press
            } else {
                MouseButtonAction::Release
            };
            let Some(button) = MouseButton::from_u8(buffer.get_u8()) else {
                warn!("[Stream Input]: recieved invalid mouse button");
                return;
            };

            let _ = stream.send_mouse_button(action, button);
        } else if ty == 3 {
            // Mouse Wheel High Res
            let delta_x = buffer.get_i16();
            let delta_y = buffer.get_i16();

            if delta_y != 0 {
                let _ = stream.send_high_res_scroll(delta_y);
            }

            if delta_x != 0 {
                let _ = stream.send_high_res_horizontal_scroll(delta_x);
            }
        } else if ty == 4 {
            // Mouse Wheel Normal
            let delta_x = buffer.get_i8();
            let delta_y = buffer.get_i8();

            if delta_y != 0 {
                let _ = stream.send_scroll(delta_y);
            }

            if delta_x != 0 {
                let _ = stream.send_horizontal_scroll(delta_x);
            }
        }
    }

    fn on_keyboard_message(stream: &MoonlightStream, message: DataChannelMessage) {
        let mut buffer = ByteBuffer::new(message.data);

        let ty = buffer.get_u8();
        if ty == 0 {
            let action = if buffer.get_bool() {
                KeyAction::Down
            } else {
                KeyAction::Up
            };
            let modifiers = KeyModifiers::from_bits(buffer.get_u8() as i8).unwrap_or_else(|| {
                warn!("[Stream Input]: received invalid key modifiers");
                KeyModifiers::empty()
            });
            let key = buffer.get_u16();

            let _ = stream.send_keyboard_event_non_standard(
                key as i16,
                action,
                modifiers,
                KeyFlags::empty(),
            );
        } else if ty == 1 {
            let len = buffer.get_u8();
            let Ok(key) = buffer.get_utf8(len as usize) else {
                warn!("[Stream Input]: received invalid keyboard text message");
                return;
            };

            let _ = stream.send_text(key);
        }
    }

    pub async fn send_controller_rumble(
        &self,
        controller_number: u8,
        low_frequency_motor: u16,
        high_frequency_motor: u16,
    ) {
        if let Some(controllers) = self.controllers.read().await.as_ref() {
            let mut raw_buffer = [0u8; 6];
            let mut buffer = ByteBuffer::new(&mut raw_buffer);

            buffer.put_u8(0);
            buffer.put_u8(controller_number);
            buffer.put_u16(low_frequency_motor);
            buffer.put_u16(high_frequency_motor);

            let _ = controllers.send(&Bytes::copy_from_slice(&raw_buffer)).await;
        }
    }
    pub async fn send_controller_trigger_rumble(
        &self,
        controller_number: u8,
        left_trigger_motor: u16,
        right_trigger_motor: u16,
    ) {
        if let Some(controllers) = self.controllers.read().await.as_ref() {
            let mut raw_buffer = [0u8; 6];
            let mut buffer = ByteBuffer::new(&mut raw_buffer);

            buffer.put_u8(0);
            buffer.put_u8(controller_number);
            buffer.put_u16(left_trigger_motor);
            buffer.put_u16(right_trigger_motor);

            let _ = controllers.send(&Bytes::copy_from_slice(&raw_buffer)).await;
        }
    }

    async fn on_controller_message(message: DataChannelMessage, connection: &StreamConnection) {
        let mut buffer = ByteBuffer::new(message.data);

        let ty = buffer.get_u8();
        if ty == 0 {
            let id = buffer.get_u8();
            let supported_buttons = ControllerButtons::from_bits(buffer.get_u32())
                .unwrap_or(DEFAULT_CONTROLLER_BUTTONS);
            let capabilities = ControllerCapabilities::from_bits(buffer.get_u16())
                .unwrap_or(DEFAULT_CONTROLLER_CAPABILITIES);

            let Some(id_gamepads) = ActiveGamepads::from_id(id) else {
                return;
            };
            let active_gamepads = {
                let mut active_gamepads = connection.input.active_gamepads.write().await;
                active_gamepads.insert(id_gamepads);
                *active_gamepads
            };

            if let Some(stream) = connection.stream.read().await.as_ref() {
                let _ = stream.send_controller_arrival(
                    id,
                    active_gamepads,
                    ControllerType::Unknown,
                    supported_buttons,
                    capabilities,
                );
            }
        } else if ty == 1 {
            let id = buffer.get_u8();

            let Some(id_gamepads) = ActiveGamepads::from_id(id) else {
                return;
            };
            let new_active_gamepads = {
                let mut active_gamepads = connection.input.active_gamepads.write().await;
                active_gamepads.remove(id_gamepads);
                *active_gamepads
            };

            if let Some(stream) = connection.stream.read().await.as_ref() {
                let _ = stream.send_multi_controller(
                    id,
                    new_active_gamepads,
                    ControllerButtons::empty(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                );
            }
        }
    }
    async fn on_controller_input_message(
        controller_id: u8,
        message: DataChannelMessage,
        connection: &StreamConnection,
    ) {
        let stream = connection.stream.read().await;
        let Some(stream) = stream.as_ref() else {
            return;
        };

        let mut buffer = ByteBuffer::new(message.data);

        let ty = buffer.get_u8();
        if ty == 0 {
            let Some(gamepad) = ActiveGamepads::from_id(controller_id) else {
                warn!("[Stream Input]: Gamepad {controller_id} is not valid");
                return;
            };

            let active_gamepads = { *connection.input.active_gamepads.read().await };
            if !active_gamepads.contains(gamepad) {
                warn!("[Stream Input]: Gamepad {controller_id} not in active gamepad mask");
                return;
            }

            let Some(buttons) = ControllerButtons::from_bits(buffer.get_u32()) else {
                warn!("[Stream Input]: received invalid controller buttons");
                return;
            };
            let left_trigger = buffer.get_u8();
            let right_trigger = buffer.get_u8();
            let left_stick_x = buffer.get_i16();
            let left_stick_y = buffer.get_i16();
            let right_stick_x = buffer.get_i16();
            let right_stick_y = buffer.get_i16();

            let _ = stream.send_multi_controller(
                controller_id,
                active_gamepads,
                buttons,
                left_trigger,
                right_trigger,
                left_stick_x,
                left_stick_y,
                right_stick_x,
                right_stick_y,
            );
        }
    }
}
