use bytes::Bytes;

use crate::video::{
    annexb::AnnexBSplitter,
    h264::{Nal, NalHeader, NalUnitType},
};

pub struct H264Reader {
    annex_b: AnnexBSplitter,
}

impl H264Reader {
    pub fn new(data: Bytes) -> Self {
        Self {
            annex_b: AnnexBSplitter::new(data),
        }
    }

    pub fn next_nal(&mut self) -> Option<Nal> {
        loop {
            if let Some(annex_b) = self.annex_b.next() {
                let header_range = annex_b.payload_range.start..(annex_b.payload_range.start + 1);

                // Ensure we have enough data for header
                if annex_b.full.len() < header_range.end {
                     continue; // Should not happen if AnnexBData is valid
                }

                let mut header = [0u8; 1];
                header.copy_from_slice(&annex_b.full[header_range.clone()]);
                let header = NalHeader::parse(header);

                if header.nal_unit_type == NalUnitType::Sei {
                    continue;
                }

                let payload_range = header_range.end..annex_b.payload_range.end;

                return Some(Nal {
                    payload_range,
                    header,
                    header_range,
                    start_code: annex_b.start_code,
                    start_code_range: annex_b.start_code_range,
                    full: annex_b.full, // Bytes, cloned (ref count incr)
                });
            } else {
                return None;
            }
        }
    }

    pub fn reset(&mut self, data: Bytes) {
        self.annex_b.reset(data);
    }
}
