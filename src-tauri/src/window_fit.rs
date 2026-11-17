//! Fitting the main window to the monitor's WORK AREA.
//!
//! The window used to ask for a fixed 1280 x 860 logical pixels. At 200 % scaling that is
//! 2560 x 1720 physical pixels, while a 1440 x 900 screen has a work area of only
//! 1440 x 852 (the taskbar takes the rest): the title bar went under the taskbar and part
//! of the window was off-screen. The rule below works in physical pixels against the work
//! area Windows reports, keeps a margin, and lets the minimum size yield when the screen
//! cannot hold it. It is pure, so the rule is tested without a monitor.

/// Free physical pixels kept between the window and every edge of the work area: the
/// shadow and the resize border live there, so the frame never touches the taskbar.
pub const WINDOW_MARGIN: u32 = 24;

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// The window size (physical pixels) that fits `work`: the preferred size clamped to the
/// work area minus the margin, never below the minimum — except that a minimum larger than
/// the work area yields to it, so the window can still be seen and moved.
pub fn fit_window_to_work_area(work: Rect, preferred: (u32, u32), minimum: (u32, u32)) -> (u32, u32) {
    let avail_w = work
        .width
        .saturating_sub(WINDOW_MARGIN.saturating_mul(2))
        .max(1);
    let avail_h = work
        .height
        .saturating_sub(WINDOW_MARGIN.saturating_mul(2))
        .max(1);
    let min_w = minimum.0.min(avail_w);
    let min_h = minimum.1.min(avail_h);
    (
        preferred.0.clamp(min_w, avail_w),
        preferred.1.clamp(min_h, avail_h),
    )
}

/// The top-left corner (physical pixels) that centres a window of `size` in `work`. A
/// window larger than the work area is pinned to its top-left instead of overflowing it.
pub fn centre_in_work_area(work: Rect, size: (u32, u32)) -> (i32, i32) {
    let dx = (work.width.saturating_sub(size.0) / 2) as i32;
    let dy = (work.height.saturating_sub(size.1) / 2) as i32;
    (work.x + dx, work.y + dy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_200_percent_window_fits_a_1440x852_work_area() {
        // 1280 x 860 logical at 200 %, against the reported 1440 x 852 work area.
        let work = Rect::new(0, 0, 1440, 852);
        let (w, h) = fit_window_to_work_area(work, (2560, 1720), (1600, 1200));
        assert_eq!((w, h), (1440 - 2 * WINDOW_MARGIN, 852 - 2 * WINDOW_MARGIN));
        assert!(w <= work.width && h <= work.height);
    }

    #[test]
    fn a_window_that_already_fits_is_kept() {
        let work = Rect::new(0, 0, 1920, 1040);
        assert_eq!(
            fit_window_to_work_area(work, (1280, 860), (800, 600)),
            (1280, 860)
        );
    }

    #[test]
    fn the_minimum_size_yields_on_a_small_screen() {
        let work = Rect::new(0, 0, 500, 400);
        let (w, h) = fit_window_to_work_area(work, (1280, 860), (800, 600));
        assert_eq!((w, h), (500 - 2 * WINDOW_MARGIN, 400 - 2 * WINDOW_MARGIN));
        assert!(w < 800 && h < 600);
    }

    #[test]
    fn the_window_is_centred_in_the_physical_work_area() {
        let work = Rect::new(-1920, 0, 1920, 1040);
        assert_eq!(centre_in_work_area(work, (1280, 860)), (-1600, 90));
        // larger than the area: pinned to the top-left, never pushed past it
        assert_eq!(centre_in_work_area(work, (2000, 1200)), (-1920, 0));
    }
}
