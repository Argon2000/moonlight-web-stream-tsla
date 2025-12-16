use std::ops::Range;

use bytes::Bytes;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnnexBStartCode {
    B3,
    B4,
}

impl AnnexBStartCode {
    #[allow(dead_code)]
    pub fn code(&self) -> &'static [u8] {
        match self {
            Self::B3 => &[0, 0, 1],
            Self::B4 => &[0, 0, 0, 1],
        }
    }
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        match self {
            Self::B3 => self.code().len(),
            Self::B4 => self.code().len(),
        }
    }
}

pub struct AnnexBData {
    pub payload_range: Range<usize>,
    pub start_code: AnnexBStartCode,
    pub start_code_range: Range<usize>,
    pub full: Bytes,
}

pub struct AnnexBSplitter {
    data: Bytes,
    offset: usize,
}

impl AnnexBSplitter {
    pub fn new(data: Bytes) -> Self {
        Self {
            data,
            offset: 0,
        }
    }

    pub fn reset(&mut self, data: Bytes) {
        self.data = data;
        self.offset = 0;
    }

    pub fn next(&mut self) -> Option<AnnexBData> {
        if self.offset >= self.data.len() {
            return None;
        }

        let current_slice = &self.data[self.offset..];
        let (start_code, sc_len) = if current_slice.starts_with(&[0, 0, 0, 1]) {
            (AnnexBStartCode::B4, 4)
        } else if current_slice.starts_with(&[0, 0, 1]) {
            (AnnexBStartCode::B3, 3)
        } else {
            // Should verify if we always start with a start code in valid Annex B
            // If not, we might need to scan for the first one?
            // Assuming we are at a start code or start of stream
            
            // If we are not at a start code, we scan for one to start?
            // The original implementation buffered bytes until it found one.
            // Let's scan.
            match find_start_code(current_slice) {
                Some((found_offset, sc, len)) => {
                    self.offset += found_offset;
                    (sc, len)
                }
                None => {
                    // No start code found in remaining data.
                    // This might be garbage or end of stream.
                    self.offset = self.data.len();
                    return None;
                }
            }
        };

        // We are at a start code.
        let payload_start = self.offset + sc_len;
        
        // Find next start code to determine end of this NAL
        let next_sc_offset = if payload_start < self.data.len() {
             find_start_code(&self.data[payload_start..]).map(|(off, _, _)| payload_start + off)
        } else {
            None
        };

        let payload_end = next_sc_offset.unwrap_or(self.data.len());
        
        // Construct the NAL data
        // We return the slice including the start code
        let nal_len = payload_end - self.offset;
        let full = self.data.slice(self.offset..payload_end);
        
        self.offset = payload_end;

        Some(AnnexBData {
            payload_range: sc_len..nal_len,
            start_code,
            start_code_range: 0..sc_len,
            full,
        })
    }
}

fn find_start_code(data: &[u8]) -> Option<(usize, AnnexBStartCode, usize)> {
    let mut i = 0;
    while i < data.len().saturating_sub(2) {
        if data[i] == 0 && data[i+1] == 0 {
            if data[i+2] == 1 {
                // Found 00 00 01
                // Check if it was 00 00 00 01
                if i > 0 && data[i-1] == 0 {
                    return Some((i-1, AnnexBStartCode::B4, 4));
                } else {
                    return Some((i, AnnexBStartCode::B3, 3));
                }
            } else if data[i+2] == 0 {
                // 00 00 00 ... might be start of 00 00 00 01
                if i + 3 < data.len() && data[i+3] == 1 {
                    return Some((i, AnnexBStartCode::B4, 4));
                }
                // Continue searching from i+1 (optimization: i+3?)
                // If we have 00 00 00 00, next check at i+1 sees 00 00 00.
                i += 1; 
                continue;
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_splitter_single_b3() {
        let data = Bytes::from_static(&[0, 0, 1, 0x42, 0x01, 0x02]);
        let mut splitter = AnnexBSplitter::new(data.clone());

        let nal = splitter.next().unwrap();
        assert_eq!(nal.start_code, AnnexBStartCode::B3);
        assert_eq!(&nal.full[nal.payload_range.clone()], &[0x42, 0x01, 0x02]);
        assert!(splitter.next().is_none());
    }

    #[test]
    fn test_splitter_single_b4() {
        let data = Bytes::from_static(&[0, 0, 0, 1, 0x44, 0x05]);
        let mut splitter = AnnexBSplitter::new(data.clone());

        let nal = splitter.next().unwrap();
        assert_eq!(nal.start_code, AnnexBStartCode::B4);
        assert_eq!(&nal.full[nal.payload_range.clone()], &[0x44, 0x05]);
        assert!(splitter.next().is_none());
    }

    #[test]
    fn test_splitter_multiple_nalus() {
        let data = Bytes::from_static(&[0, 0, 0, 1, 0x42, 0x01, 0x02, 0, 0, 1, 0x44, 0x03, 0x04]);
        let mut splitter = AnnexBSplitter::new(data.clone());

        let nal1 = splitter.next().unwrap();
        assert_eq!(nal1.start_code, AnnexBStartCode::B4);
        assert_eq!(&nal1.full[nal1.payload_range.clone()], &[0x42, 0x01, 0x02]);

        let nal2 = splitter.next().unwrap();
        assert_eq!(nal2.start_code, AnnexBStartCode::B3);
        assert_eq!(&nal2.full[nal2.payload_range.clone()], &[0x44, 0x03, 0x04]);
        
        assert!(splitter.next().is_none());
    }

    #[test]
    fn test_splitter_no_nalus() {
        let data = Bytes::from_static(&[0x01, 0x02, 0x03]);
        let mut splitter = AnnexBSplitter::new(data.clone());

        assert!(splitter.next().is_none());
    }

    #[test]
    fn test_splitter_edge_case_start_of_stream() {
        let data = Bytes::from_static(&[0, 0, 0, 1, 0x42]);
        let mut splitter = AnnexBSplitter::new(data.clone());

        let nal = splitter.next().unwrap();
        assert_eq!(nal.start_code, AnnexBStartCode::B4);
        assert_eq!(&nal.full[nal.payload_range.clone()], &[0x42]);
    }
    
    #[test]
    fn test_splitter_mid_stream_start() {
        // Data has some garbage then start code
        let data = Bytes::from_static(&[0xFF, 0xEE, 0, 0, 1, 0x42]);
        let mut splitter = AnnexBSplitter::new(data.clone());
        
        let nal = splitter.next().unwrap();
        assert_eq!(nal.start_code, AnnexBStartCode::B3);
        assert_eq!(&nal.full[nal.payload_range.clone()], &[0x42]);
    }
}
