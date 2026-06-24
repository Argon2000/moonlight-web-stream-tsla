use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use serde::{Deserialize, Serialize};

use crate::api_bindings::RtcIceServer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Use the ApiCredentials struct instead if you are verify the user!
    pub credentials: Option<String>,
    /// Base32-encoded TOTP secret for 2FA. Set via the web UI; do not edit manually.
    #[serde(default)]
    pub totp_secret: Option<String>,
    #[serde(default = "data_path_default")]
    pub data_path: String,
    #[serde(default = "default_bind_address")]
    pub bind_address: SocketAddr,
    /// Optional second address to bind HTTPS on when a certificate is configured.
    /// When set, `bind_address` serves plain HTTP and this address serves HTTPS.
    /// When unset, `bind_address` serves HTTPS (or HTTP if no cert).
    #[serde(default)]
    pub bind_address_https: Option<SocketAddr>,
    #[serde(default = "moonlight_default_http_port_default")]
    pub moonlight_default_http_port: u16,
    #[serde(default = "default_pair_device_name")]
    pub pair_device_name: String,
    #[serde(default = "default_ice_servers")]
    pub webrtc_ice_servers: Vec<RtcIceServer>,
    #[serde(default = "default_webrtc_port_range")]
    pub webrtc_port_range: Option<PortRange>,
    #[serde(default = "default_webrtc_nat_1to1")]
    pub webrtc_nat_1to1: Option<WebRtcNat1To1Mapping>,
    #[serde(default = "default_network_types")]
    pub webrtc_network_types: Vec<WebRtcNetworkType>,
    #[serde(default)]
    pub web_path_prefix: String,
    pub certificate: Option<ConfigSsl>,
    #[serde(default = "default_streamer_path")]
    pub streamer_path: String,
    #[serde(default)]
    pub external_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum WebRtcNetworkType {
    #[serde(rename = "udp4")]
    Udp4,
    #[serde(rename = "udp6")]
    Udp6,
    #[serde(rename = "tcp4")]
    Tcp4,
    #[serde(rename = "tcp6")]
    Tcp6,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebRtcNat1To1Mapping {
    pub ips: Vec<String>,
    pub ice_candidate_type: WebRtcNat1To1IceCandidateType,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum WebRtcNat1To1IceCandidateType {
    #[serde(rename = "srflx")]
    Srflx,
    #[serde(rename = "host")]
    Host,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSsl {
    pub private_key_pem: String,
    pub certificate_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortRange {
    pub min: u16,
    pub max: u16,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            credentials: Some("default".to_string()),
            totp_secret: None,
            data_path: data_path_default(),
            bind_address: default_bind_address(),
            bind_address_https: None,
            moonlight_default_http_port: moonlight_default_http_port_default(),
            webrtc_ice_servers: default_ice_servers(),
            webrtc_port_range: default_webrtc_port_range(),
            webrtc_nat_1to1: default_webrtc_nat_1to1(),
            webrtc_network_types: default_network_types(),
            pair_device_name: default_pair_device_name(),
            web_path_prefix: String::new(),
            certificate: None,
            streamer_path: default_streamer_path(),
            external_url: None,
        }
    }
}

fn data_path_default() -> String {
    "server/data.json".to_string()
}

fn default_bind_address() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 8080))
}

fn moonlight_default_http_port_default() -> u16 {
    47989
}

fn default_ice_servers() -> Vec<RtcIceServer> {
    vec![
        RtcIceServer {
            urls: vec![
                "stun:stun.cloudflare.com:3478".to_owned(),
                "stun:stun.l.google.com:19302".to_owned(),
                "stun:stun1.l.google.com:3478".to_owned(),
                "stun:stun2.l.google.com:19302".to_owned(),
                "stun:stun3.l.google.com:3478".to_owned(),
                "stun:stun4.l.google.com:19302".to_owned(),
            ],
            ..Default::default()
        },
    ]
}
fn default_network_types() -> Vec<WebRtcNetworkType> {
    vec![WebRtcNetworkType::Udp4]
}
fn default_webrtc_nat_1to1() -> Option<WebRtcNat1To1Mapping> {
    Some(WebRtcNat1To1Mapping {
        ice_candidate_type: WebRtcNat1To1IceCandidateType::Srflx,
        ips: vec!["<YOUR_PUBLIC_IP>".to_owned()],
    })
}
fn default_webrtc_port_range() -> Option<PortRange> {
    Some(PortRange { min: 40000, max: 40100 })
}

fn default_pair_device_name() -> String {
    "roth".to_string()
}

fn default_streamer_path() -> String {
    "./streamer".to_string()
}

impl Config {
    /// Validate the configuration at startup.
    /// Returns collected warnings (logged but non-fatal) and errors (fatal).
    pub fn validate(&self) -> (Vec<String>, Vec<String>) {
        let mut warnings = Vec::new();
        let mut errors = Vec::new();

        // NAT IP placeholders — warn only (local-only use is valid)
        if let Some(nat) = &self.webrtc_nat_1to1 {
            for ip in &nat.ips {
                if ip.contains('<') || ip.contains('>') {
                    warnings.push(format!(
                        "Placeholder NAT IP '{}' — streaming over the Internet will likely fail. \
                         Replace with your real public IP (check https://whatismyip.com).",
                        ip
                    ));
                }
            }
        }

        // Port range sanity
        if let Some(range) = &self.webrtc_port_range {
            if range.min == 0 {
                errors.push("webrtc_port_range.min must be > 0".to_string());
            }
            if range.min > range.max {
                errors.push(format!(
                    "webrtc_port_range: min ({}) must be ≤ max ({})",
                    range.min, range.max
                ));
            }
        }

        // Certificate files must exist when configured
        if let Some(cert) = &self.certificate {
            if !std::path::Path::new(&cert.private_key_pem).exists() {
                errors.push(format!(
                    "certificate.private_key_pem: file not found: {}",
                    cert.private_key_pem
                ));
            }
            if !std::path::Path::new(&cert.certificate_pem).exists() {
                errors.push(format!(
                    "certificate.certificate_pem: file not found: {}",
                    cert.certificate_pem
                ));
            }
        }

        (warnings, errors)
    }
}
