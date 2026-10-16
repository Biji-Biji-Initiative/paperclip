//! Private, non-Debug/non-Serialize buffers. No dependency or provider behavior change.
//!
//! Drop overwrites the owned logical buffer as a best-effort hygiene measure.
//! This is not a promise to erase allocator copies, serde temporaries, swap or
//! core dumps. The security boundary is bounded private ingress and suppression
//! before tracing/errors/events, not a claim of universally erased process RAM.
use std::hint::black_box;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{compiler_fence, Ordering};

pub(crate) trait Wipe {
    fn wipe(&mut self);
}
impl Wipe for Vec<u8> {
    fn wipe(&mut self) {
        black_box(self.as_mut_slice()).fill(0);
        compiler_fence(Ordering::SeqCst);
    }
}
impl<const N: usize> Wipe for [u8; N] {
    fn wipe(&mut self) {
        black_box(self.as_mut_slice()).fill(0);
        compiler_fence(Ordering::SeqCst);
    }
}
impl Wipe for String {
    fn wipe(&mut self) {
        // Same-length valid UTF-8 replacement, without unsafe access to String.
        let zeros = "\0".repeat(self.len());
        self.replace_range(.., &zeros);
        black_box(self.as_mut_str());
        compiler_fence(Ordering::SeqCst);
        self.clear();
    }
}
pub(crate) struct Sensitive<T: Wipe>(T);
impl<T: Wipe> Sensitive<T> {
    pub(crate) fn new(value: T) -> Self {
        Self(value)
    }
}
impl<T: Wipe> Deref for Sensitive<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}
impl<T: Wipe> DerefMut for Sensitive<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}
impl<T: Wipe> Drop for Sensitive<T> {
    fn drop(&mut self) {
        self.0.wipe();
    }
}
