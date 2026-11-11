//! Main-thread touch identity and picture-coordinate mapping, independent of UIKit.
/// A stable finger ID and position measured from the visible picture's top left.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Touch {
    /// Stable until this finger ends, in 0..16.
    pub id: u32,
    /// Horizontal picture coordinate, in 0..=1.
    pub x: f32,
    /// Vertical picture coordinate, in 0..=1.
    pub y: f32,
}
#[derive(Clone, Copy)]
struct Finger {
    identity: usize,
    touch: Touch,
}
#[derive(Default)]
pub(crate) struct Touches {
    fingers: [Option<Finger>; 16],
}
impl Touches {
    pub fn begin(&mut self, identity: usize, point: Option<(f32, f32)>) {
        if self
            .fingers
            .iter()
            .flatten()
            .any(|f| f.identity == identity)
        {
            return;
        }
        let Some((x, y)) = point else {
            return;
        };
        if let Some((id, slot)) = self
            .fingers
            .iter_mut()
            .enumerate()
            .find(|(_, s)| s.is_none())
        {
            *slot = Some(Finger {
                identity,
                touch: Touch {
                    id: id as u32,
                    x,
                    y,
                },
            });
        }
    }
    pub fn moved(&mut self, identity: usize, point: Option<(f32, f32)>) {
        if let Some((x, y)) = point {
            if let Some(f) = self
                .fingers
                .iter_mut()
                .flatten()
                .find(|f| f.identity == identity)
            {
                f.touch.x = x;
                f.touch.y = y;
            }
        }
    }
    pub fn end(&mut self, identity: usize) {
        if let Some(slot) = self
            .fingers
            .iter_mut()
            .find(|s| s.is_some_and(|f| f.identity == identity))
        {
            *slot = None;
        }
    }
    pub fn clear(&mut self) {
        self.fingers.fill(None);
    }
    pub fn snapshot(&self) -> Vec<Touch> {
        self.fingers.iter().flatten().map(|f| f.touch).collect()
    }
}
/// Maps the actual picture, not assumed 16:9 content. None means the backend fills
/// the drawable. Some(aspect) is only valid when the backend actually aspect-fits.
/// New fingers in letterbox bars are rejected; existing drags clamp to the edge.
pub(crate) fn normalize(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    aspect: Option<f64>,
    clamp: bool,
) -> Option<(f32, f32)> {
    if ![x, y, width, height].iter().all(|n| n.is_finite()) || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let (w, h) = match aspect {
        Some(a) if a.is_finite() && a > 0.0 => {
            if width / height > a {
                (height * a, height)
            } else {
                (width, width / a)
            }
        }
        Some(_) => return None,
        None => (width, height),
    };
    let px = (x - (width - w) * 0.5) / w;
    let py = (y - (height - h) * 0.5) / h;
    if !clamp && (!(0.0..=1.0).contains(&px) || !(0.0..=1.0).contains(&py)) {
        return None;
    }
    Some((px.clamp(0.0, 1.0) as f32, py.clamp(0.0, 1.0) as f32))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_ids_survive_moves_and_other_fingers_ending() {
        let mut t = Touches::default();
        t.begin(100, Some((0.2, 0.3)));
        t.begin(200, Some((0.4, 0.5)));
        t.end(100);
        t.moved(200, Some((0.8, 0.9)));
        t.begin(300, Some((0.1, 0.1)));
        assert_eq!(
            t.snapshot()[1],
            Touch {
                id: 1,
                x: 0.8,
                y: 0.9
            }
        );
        assert_eq!(t.snapshot()[0].id, 0);
        t.begin(200, Some((0.0, 0.0)));
        assert_eq!(t.snapshot().len(), 2);
    }
    #[test]
    fn only_sixteen_fingers_and_cancel_releases_everything() {
        let mut t = Touches::default();
        for key in 0..20 {
            t.begin(key, Some((0.5, 0.5)));
        }
        assert_eq!(t.snapshot().len(), 16);
        assert_eq!(t.snapshot()[15].id, 15);
        t.clear();
        assert!(t.snapshot().is_empty());
        t.moved(0, Some((0.1, 0.1)));
        assert!(t.snapshot().is_empty());
    }
    #[test]
    fn landscape_and_portrait_letterboxes_are_excluded() {
        assert_eq!(
            normalize(100.0, 50.0, 200.0, 100.0, Some(1.0), false),
            Some((0.5, 0.5))
        );
        assert_eq!(normalize(10.0, 50.0, 200.0, 100.0, Some(1.0), false), None);
        assert_eq!(
            normalize(10.0, 50.0, 200.0, 100.0, Some(1.0), true),
            Some((0.0, 0.5))
        );
        assert_eq!(normalize(50.0, 10.0, 100.0, 200.0, Some(1.0), false), None);
        assert_eq!(
            normalize(50.0, 100.0, 100.0, 200.0, Some(1.0), false),
            Some((0.5, 0.5))
        );
    }
    #[test]
    fn full_drawable_mapping_and_invalid_geometry() {
        assert_eq!(
            normalize(25.0, 75.0, 100.0, 100.0, None, false),
            Some((0.25, 0.75))
        );
        assert_eq!(normalize(f64::NAN, 0.0, 100.0, 100.0, None, false), None);
        assert_eq!(normalize(0.0, 0.0, 0.0, 100.0, None, false), None);
        assert_eq!(normalize(0.0, 0.0, 100.0, 100.0, Some(0.0), false), None);
        let mut t = Touches::default();
        t.begin(1, None);
        assert!(t.snapshot().is_empty());
    }
}
