// Adapted from NX2Apple / nxnative. MIT license and exact provenance: LICENSE and SOURCE.json.
// NX2Apple's actual single-game overlay, adapted to nxkit's C ABI.
// Drawing, hit geometry and gesture ownership are retained, not redesigned.
// Physical controller/motion ownership stays in nxkit. The shell is landscape.
#import <UIKit/UIKit.h>
#import <GameController/GameController.h>
#import <CoreText/CoreText.h>
#import "Nx2ipaOverlay.h"
#import "DmPadGeometry.h"
#include <math.h>
#include <stdlib.h>
#define LOG(...) NSLog(@"nx2ipa: " __VA_ARGS__)

enum { B_A = 0, B_B, B_X, B_Y, B_LS, B_RS, B_L, B_R, B_ZL, B_ZR, B_PLUS, B_MINUS, B_LEFT, B_UP, B_RIGHT, B_DOWN, B_N };
enum { C_NONE = 0, C_STICK, C_DPAD, C_FACE, C_BTN, C_GAME };   // which control a touch holds; C_GAME: none, the touch goes to the game's touch screen (finger slot << 8)

// ---- Layout constants ----
// Where each control is drawn (in u, x measured from the outer edge, the right half mirrors) is DmPadGeometry.h: pure functions of the bounds, the safe area,
// the DmLayout split and the player's options (DM_TOUCH_SIZE), tested on the Mac (dm/ios/tests/test_pad_geometry.py). Drawing, the hit-test and the grab all read it.
// The bottom-corner controls reach halfway into the side safe-area inset (in landscape there is only the rounded screen corner there; the Dynamic Island is mid-edge);
// the stick's ring is as large as the whole diamond (key distance + key radius), the knob a little larger than a diamond key; the D-pad sits inward of and below the
// left stick, as on a Pro Controller. The menu button is at the top centre, level with - / +, and takes a touch within 1.6 times its radius (at least 22 points, half of a 44-point target). What stays here is how touches are taken:
static const CGFloat                               // (the grab radii of the stick and the D-pad are DmPadGeometry.h's DM_PAD_STICK_GRAB and DM_PAD_DPAD_GRAB)
    K_FULL = 0.8,                                   // full tilt at this fraction of the ring radius (the knob still travels to the ring edge)
    K_DEAD = 0.1,                                   // stick dead zone (times the ring radius)
    K_RSTICK_R = 60,                                // right stick (not drawn): radius around its centre, the touch-down point
    K_RSWIPE = 1.0 / 3,                             // right stick area: this fraction of the screen width from the right edge (not in u)
    K_MENU_IDLE = 3.0;                              // seconds a connected controller leaves the menu gear visible before fading it out
static const int k_btns[] = {B_ZL, B_L, B_ZR, B_R, B_MINUS, B_PLUS, B_LS, B_RS};   // keys locked at touch-down (L3 / R3 only in the 3D layout)
static NSString *const k_toggle_key = @"nx2ipa.pad.toggles";   // NSUserDefaults: the in-game menu's keys that toggle (DmPadGeometry.h's value)
static NSString *const k_layout_key = @"nx2ipa.pad.layout";   // NSUserDefaults: 0 = 2D, 1 = 3D, 2 = Tap (DM_GAME_PAD_LAYOUT's numbers)

@interface Nx2ipaGamepad : UIView
- (void)arrange:(DmLayout)layout;
- (void)setToggleMask:(unsigned)mask;
- (unsigned)toggleMask;
- (void)setToggle:(int)control on:(BOOL)on;
- (BOOL)menuTakes:(CGPoint)p;
- (BOOL)voiceOverRunning;
- (BOOL)reduceMotionEnabled;
- (void)wakeMenu;
- (void)setMenuOpen:(BOOL)open;
@end
// The menu button: a UIButton whose menu is the in-game menu (UIKit draws it and takes the touches while it is open). Its hit circle is larger than the drawn one, and a key nearer
// to the touch wins (− / + sit beside it), so it asks the pad
@interface Nx2ipaMenuButton : UIButton
@end
@implementation Nx2ipaMenuButton
- (BOOL)pointInside:(CGPoint)p withEvent:(UIEvent *)e { Nx2ipaGamepad *pad = (Nx2ipaGamepad *)self.superview; return [pad menuTakes:[self convertPoint:p toView:pad]]; }
- (void)touchesBegan:(NSSet<UITouch *> *)ts withEvent:(UIEvent *)e { [super touchesBegan:ts withEvent:e]; [(Nx2ipaGamepad *)self.superview wakeMenu]; }
- (void)contextMenuInteraction:(UIContextMenuInteraction *)i willDisplayMenuForConfiguration:(UIContextMenuConfiguration *)c animator:(id<UIContextMenuInteractionAnimating>)a {
    [super contextMenuInteraction:i willDisplayMenuForConfiguration:c animator:a]; [(Nx2ipaGamepad *)self.superview setMenuOpen:YES];
}
- (void)contextMenuInteraction:(UIContextMenuInteraction *)i willEndForConfiguration:(UIContextMenuConfiguration *)c animator:(id<UIContextMenuInteractionAnimating>)a {
    [super contextMenuInteraction:i willEndForConfiguration:c animator:a]; [(Nx2ipaGamepad *)self.superview setMenuOpen:NO];
}
@end
static __weak Nx2ipaGamepad *g_view;

@implementation Nx2ipaGamepad {
    NSMapTable<UITouch *, NSNumber *> *_owner;     // touch → control (with the key for C_BTN or the stick for C_STICK, << 8)
    UITouch *_stick[2]; CGPoint _stickNow[2];      // the touch holding each stick and where it is now (0 left, 1 right)
    CGPoint _rCentre;                              // the right stick's centre: where its touch landed, dragged along past K_RSTICK_R
    uint64_t _faceBits, _dpadBits, _btnBits;
    uint64_t _toggle, _latched;                    // DM_TOUCH_TOGGLE's keys (1 << B_*), and the ones a tap turned on
    unsigned _toggleControls;                      // the same keys as DmPadGeometry.h's controls (1 << DM_PAD_C_*)
    NSMapTable<UITouch *, NSNumber *> *_faceOf;    // which keys each touch on the diamond currently holds
    CAShapeLayer *_key[B_N]; CATextLayer *_label[B_N];   // one layer per key
    CAShapeLayer *_ring, *_knob;                   // the left stick (the right one is not drawn)
    CALayer *_hint; CATextLayer *_hintText; NSString *_hintWords;   // the 3D layout's right-stick hint: words only, once per launch (see "The right-stick hint")
    Nx2ipaMenuButton *_menu;                           // opens the in-game menu (GameMenu.swift)
    unsigned _menuGen;                             // generation counter for the controller-idle menu fade timer
    BOOL _menuOpen;                                // the in-game menu is currently presented
    UIImpactFeedbackGenerator *_touchFeedback;       // one short feedback per touch-control press edge
    unsigned _hapticSticks;
    BOOL _stickShown;                              // the left stick was held at the last refresh
    BOOL _active;
    BOOL _full, _tap;                              // the 3D layout / the Tap layout is current
    CALayer *_controls;                            // holds every control layer: hidden while a physical controller is connected (the view itself stays, for game touches)
    BOOL _padOff;                                  // a physical controller is connected: every touch goes to the game
    DmLayout _layout;
    DmPadOptions _opts;                            // the player's options from the environment (DM_TOUCH_SIZE, DM_TOUCH_STICK, DM_TOUCH_LAYOUT)
    DmPadLayout _arrangement;                      // DM_TOUCH_LAYOUT, which _opts.layout points to
    DmPadGeo _geo; CGRect _geoBounds; UIEdgeInsets _geoInsets; BOOL _geoFull, _geoValid;   // where the controls are, and what it was computed for
    unsigned _loggedDropped;                       // the moved controls that kept their place, as last logged
    UITouch *_game[16];                           // touches on the game's touch screen by finger slot
}

static UIColor *k_idle, *k_on, *k_line, *k_ringFill, *k_text, *k_textOn;
static CAShapeLayer *shape(CALayer *parent) {
    CAShapeLayer *l = [CAShapeLayer layer];
    l.fillColor = k_idle.CGColor; l.strokeColor = k_line.CGColor; l.lineWidth = 1.5;
    l.shadowColor = UIColor.blackColor.CGColor; l.shadowOpacity = 0.2; l.shadowRadius = 3; l.shadowOffset = CGSizeMake(0, 1);
    [parent addSublayer:l]; return l;
}
static CATextLayer *label(CALayer *parent, NSString *s) {
    CATextLayer *t = [CATextLayer layer];
    t.string = s; t.alignmentMode = kCAAlignmentCenter; t.foregroundColor = k_text.CGColor;
    [parent addSublayer:t]; return t;
}
static int toggleKey(int c);
static BOOL fullOnly(int b) { return b == B_LS || b == B_RS || b >= B_LEFT; }   // keys shown only in the 3D layout

- (instancetype)initWithFrame:(CGRect)f {
    if ((self = [super initWithFrame:f])) {
        _layout = (DmLayout){self.bounds, self.bounds, NO, NO, NO, NO};
        NSString *savedSize = [NSUserDefaults.standardUserDefaults stringForKey:@"nx2ipa.pad.size"];
        const char *size = savedSize.UTF8String;
        _opts.scale = dm_pad_size_scale(size);
        if (size && *size) LOG("front end: touch controls size %s (DM_TOUCH_SIZE)", _opts.scale < 1 ? "small" : _opts.scale > 1 ? "large" : "medium");
        NSString *savedStick = [NSUserDefaults.standardUserDefaults stringForKey:@"nx2ipa.pad.stick"];
        const char *stick = savedStick.UTF8String;
        _opts.stick = dm_pad_stick_place(stick);
        if (stick && *stick) LOG("front end: left stick %s (DM_TOUCH_STICK)", _opts.stick == DM_PAD_STICK_HIGHER ? "higher" : _opts.stick == DM_PAD_STICK_INWARD ? "inward" : "in the corner");
        const char *arrangement = getenv("DM_TOUCH_LAYOUT");
        if (!dm_pad_layout_parse(arrangement, &_arrangement)) LOG("front end: DM_TOUCH_LAYOUT ignored (not a layout the engine reads, %zu characters): every control keeps its place", strlen(arrangement));
        else if (dm_pad_layout_count(&_arrangement)) LOG("front end: touch controls arranged by the player (DM_TOUCH_LAYOUT, %d moved over every layout)", dm_pad_layout_count(&_arrangement));
        _opts.layout = &_arrangement;
        const char *toggleEnv = getenv("DM_TOUCH_TOGGLE");
        NSString *savedToggles = toggleEnv ? nil : [NSUserDefaults.standardUserDefaults stringForKey:k_toggle_key];   // the in-game menu's choice in a game's own app
        unsigned toggles = dm_pad_toggle_parse(toggleEnv ? toggleEnv : savedToggles.UTF8String);
        [self setToggleMask:toggles];
        if (toggles) LOG("front end: touch keys that toggle (%s): %s", toggleEnv ? "DM_TOUCH_TOGGLE" : "in-game menu", toggleEnv ? toggleEnv : savedToggles.UTF8String);
        [self registerForTraitChanges:@[UITraitDisplayScale.class] withHandler:^(id<UITraitEnvironment> environment, UITraitCollection *previous) {
            [(UIView *)environment setNeedsLayout];
        }];
        self.multipleTouchEnabled = YES; self.opaque = NO; self.backgroundColor = UIColor.clearColor;
        if ([NSUserDefaults.standardUserDefaults objectForKey:@"nx2ipa.pad.feedback"] == nil || [NSUserDefaults.standardUserDefaults boolForKey:@"nx2ipa.pad.feedback"]) {
            _touchFeedback = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
            [_touchFeedback prepare];
        }
        _owner = [NSMapTable strongToStrongObjectsMapTable]; _faceOf = [NSMapTable strongToStrongObjectsMapTable];
        if (!k_idle) {
            // each colour carries its own low opacity instead of lowering the whole view's alpha (that would add an off-screen pass for the full-screen layer)
            k_idle = [UIColor colorWithWhite:1 alpha:0.14]; k_on = [UIColor colorWithWhite:1 alpha:0.45]; k_line = [UIColor colorWithWhite:1 alpha:0.38];
            k_ringFill = [UIColor colorWithWhite:1 alpha:0.06]; k_text = [UIColor colorWithWhite:1 alpha:0.6]; k_textOn = [UIColor colorWithWhite:0 alpha:0.7];
        }
        _controls = [CALayer layer]; [self.layer addSublayer:_controls];
        _ring = shape(_controls); _ring.fillColor = k_ringFill.CGColor;
        _knob = shape(_controls);
        CAShapeLayer *in = [CAShapeLayer layer]; in.fillColor = nil; in.strokeColor = k_line.CGColor; in.lineWidth = 1.5;   // inner ring of the knob
        [_knob addSublayer:in];
        static NSString *const names[B_N] = {@"A", @"B", @"X", @"Y", @"L3", @"R3", @"L", @"R", @"ZL", @"ZR", @"+", @"−"};
        for (int b = 0; b < B_N; b++) {
            _key[b] = shape(_controls);
            if (names[b]) _label[b] = label(_key[b], names[b]);   // the D-pad arms carry no label
        }
        _menu = [Nx2ipaMenuButton buttonWithType:UIButtonTypeCustom];
        _menu.backgroundColor = k_idle; _menu.layer.borderColor = k_line.CGColor; _menu.layer.borderWidth = 1.5;
        _menu.layer.shadowColor = UIColor.blackColor.CGColor; _menu.layer.shadowOpacity = 0.2; _menu.layer.shadowRadius = 3; _menu.layer.shadowOffset = CGSizeMake(0, 1);
        _menu.tintColor = k_text; _menu.accessibilityLabel = @"Menu";
        _menu.menu = CFBridgingRelease(nx2ipa_game_menu()); _menu.showsMenuAsPrimaryAction = YES;
        __weak Nx2ipaGamepad *weakSelf = self;
        [_menu addAction:[UIAction actionWithHandler:^(UIAction *a) { (void)a; [weakSelf reset]; }] forControlEvents:UIControlEventMenuActionTriggered];   // the menu opens: release every key and touch first
        [self addSubview:_menu];
        const char *hint = getenv("DM_TOUCH_HINT");   // the shell passes the player's language; empty turns the hint off
        _hintWords = hint ? [NSString stringWithUTF8String:hint] : @"Right stick: drag here";
        _hint = [CALayer layer]; _hint.backgroundColor = [UIColor colorWithWhite:0 alpha:0.5].CGColor; _hint.opacity = 0; _hint.hidden = YES;
        _hintText = [CATextLayer layer]; _hintText.string = _hintWords; _hintText.alignmentMode = kCAAlignmentCenter;
        _hintText.foregroundColor = [UIColor colorWithWhite:1 alpha:0.9].CGColor; [_hint addSublayer:_hintText]; [_controls addSublayer:_hint];
        NSNumber *saved = [NSUserDefaults.standardUserDefaults objectForKey:k_layout_key];
        int l = saved ? (int)saved.integerValue : 0;
        if (l == 2 && !nx2ipa_is_handheld()) l = 0;   // Tap only in handheld mode (env.txt's DM_OPMODE may have changed it)
        _full = l == 1; _tap = l == 2;
        [self applyLayout];
        NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
        [nc addObserver:self selector:@selector(padsChanged:) name:GCControllerDidConnectNotification object:nil];
        [nc addObserver:self selector:@selector(padsChanged:) name:GCControllerDidDisconnectNotification object:nil];
        [nc addObserver:self selector:@selector(updateControlVisibility) name:UIAccessibilityVoiceOverStatusDidChangeNotification object:nil];
        [self padsChanged:nil];
    }
    return self;
}
- (void)applyLayout {   // show / hide the controls for the current layout
    [CATransaction begin]; [CATransaction setDisableActions:YES];
    for (int b = 0; b < B_N; b++) _key[b].hidden = _tap || (fullOnly(b) && !_full);
    _ring.hidden = _knob.hidden = _tap;
    [CATransaction commit];
}
- (int)padLayout { return _tap ? 2 : _full ? 1 : 0; }
- (void)setPadLayout:(int)l {   // the in-game menu's pick: release every touch first (no key stays held), save, lay out again
    if (l == 2 && !nx2ipa_is_handheld()) l = 0;
    [self reset];
    _full = l == 1; _tap = l == 2;
    [NSUserDefaults.standardUserDefaults setObject:@(l) forKey:k_layout_key];
    [self applyLayout]; [self setNeedsLayout];
}
- (void)opmodeChanged {   // docked: the Tap layout goes (the game reads no touch screen then), unsaved, so handheld mode at the next start brings it back
    if (!_tap || nx2ipa_is_handheld()) return;
    [self reset]; _tap = NO; _full = NO; [self applyLayout]; [self setNeedsLayout];
}
- (void)setToggleMask:(unsigned)mask {   // DmPadGeometry.h's controls → the keys that toggle; a key that stops toggling is released
    _toggleControls = mask; uint64_t keys = 0;
    for (int c = 0; c < DM_PAD_C_N; c++) if (mask & (1u << c)) keys |= 1ull << toggleKey(c);
    _toggle = keys; _latched &= keys;
}
- (unsigned)toggleMask { return _toggleControls; }
- (void)setToggle:(int)control on:(BOOL)on {   // the in-game menu: at once, saved for the next start, and the same value the shell passes
    if (control < 0 || control >= DM_PAD_C_N || !dm_pad_toggleable(control)) return;
    unsigned mask = on ? _toggleControls | 1u << control : _toggleControls & ~(1u << control);
    [self setToggleMask:mask]; [self recompute];
    char value[128]; dm_pad_toggle_encode(mask, value, sizeof value);
    if (*value) { [NSUserDefaults.standardUserDefaults setObject:@(value) forKey:k_toggle_key]; setenv("DM_TOUCH_TOGGLE", value, 1); }
    else { [NSUserDefaults.standardUserDefaults removeObjectForKey:k_toggle_key]; unsetenv("DM_TOUCH_TOGGLE"); }
    LOG("front end: touch keys that toggle set in the in-game menu: %s", *value ? value : "none");
}
- (void)setTouchFeedback:(BOOL)on {
    if (!on) { _touchFeedback = nil; return; }
    if (!_touchFeedback) { _touchFeedback = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight]; [_touchFeedback prepare]; }
}

// ---- Layout (points; computed inside the safe area) ----
- (void)arrange:(DmLayout)layout {
    if (CGRectEqualToRect(_layout.controls, layout.controls) && CGRectEqualToRect(_layout.game, layout.game) && _layout.separated == layout.separated
        && _layout.topSafeOnly == layout.topSafeOnly && _layout.customControlsFullBounds == layout.customControlsFullBounds
        && _layout.onTV == layout.onTV) return;
    [self reset];   // A finger held across a pose change must not leave a key or game touch stuck.
    _layout = layout; _geoValid = NO;
    [self updateControlVisibility];
    [self setNeedsLayout];
}
- (const DmPadGeo *)geo {   // DmPadGeometry.h, computed again whenever the bounds, the safe area, the split or the layout changed
    CGRect b = self.bounds; UIEdgeInsets i = self.safeAreaInsets;
    if (!_geoValid || !CGRectEqualToRect(b, _geoBounds) || !UIEdgeInsetsEqualToEdgeInsets(i, _geoInsets) || _geoFull != _full) {
        _geo = dm_pad_geo(b, i, _layout, _full, _opts);
        _geoBounds = b; _geoInsets = i; _geoFull = _full; _geoValid = YES;
        if (_geo.dropped != _loggedDropped) {   // a moved control with no room on this screen: said once per change, for the log a player sends
            _loggedDropped = _geo.dropped;
            NSMutableArray<NSString *> *names = [NSMutableArray array];
            for (int c = 0; c < DM_PAD_C_N; c++) if (_geo.dropped & (1u << c)) [names addObject:@(dm_pad_control_names[c])];
            if (names.count) LOG("front end: touch layout: %s kept at the built-in place (no room there on this screen, or on another control)", [names componentsJoinedByString:@" "].UTF8String);
        }
    }
    return &_geo;
}
- (CGFloat)u { return self.geo->u; }   // 1 = 430 points tall (iPhone Pro Max landscape), times the player's size
- (CGPoint)faceCenter { return self.geo->face; }
- (CGFloat)faceGap { return self.geo->faceGap; }
- (CGFloat)faceR { return self.geo->faceR; }
- (CGFloat)faceHitR { return self.geo->faceHitR; }
- (CGPoint)facePos:(int)b { return dm_pad_face_key(self.geo, b - B_A); }   // B_A..B_Y are A, B, X, Y: the geometry's order
- (CGPoint)stickHome { return self.geo->stick; }
- (CGPoint)stickCentre:(int)i { return i ? _rCentre : self.stickHome; }
- (CGFloat)stickR:(int)i { return i ? K_RSTICK_R * self.u : self.geo->stickR; }
- (BOOL)inRightArea:(CGPoint)p { CGRect b = _layout.controls; return p.x >= CGRectGetMaxX(b) - b.size.width * K_RSWIPE; }
- (CGPoint)dpadCenter { return self.geo->dpad; }
- (CGFloat)dpadR { return self.geo->dpadR; }
static BOOL isDrop(int b) { return b == B_ZL || b == B_L || b == B_ZR || b == B_R; }
static BOOL isClick(int b) { return b == B_LS || b == B_RS; }
static int dropIndex(int b) { return b == B_ZL ? DM_PAD_ZL : b == B_L ? DM_PAD_L : b == B_ZR ? DM_PAD_ZR : DM_PAD_R; }
- (CGPoint)dropCenter:(int)b { return self.geo->drop[dropIndex(b)]; }
- (CGFloat)dropR:(int)b { return self.geo->dropR[dropIndex(b)]; }
- (CGPoint)clickCenter:(int)b { return self.geo->click[b == B_RS]; }
- (CGRect)pillRect:(int)b { return self.geo->pill[b == B_PLUS ? DM_PAD_PLUS : DM_PAD_MINUS]; }
- (CGPoint)menuCenter { return self.geo->swap; }

static CGFloat dist(CGPoint a, CGPoint b) { return hypot(a.x - b.x, a.y - b.y); }
static int lockedKey(int c) {   // DmPadGeometry.h's control → the key it presses
    switch (c) { case DM_PAD_C_ZL: return B_ZL; case DM_PAD_C_L: return B_L; case DM_PAD_C_ZR: return B_ZR; case DM_PAD_C_R: return B_R;
                 case DM_PAD_C_MINUS: return B_MINUS; case DM_PAD_C_PLUS: return B_PLUS; case DM_PAD_C_L3: return B_LS; default: return B_RS; }
}
static int toggleKey(int c) { return c >= DM_PAD_C_A && c <= DM_PAD_C_Y ? B_A + (c - DM_PAD_C_A) : lockedKey(c); }   // DM_TOUCH_TOGGLE's control → its key
- (BOOL)menuTakes:(CGPoint)p {   // the menu button takes a touch in its hit circle unless a locked key's target is nearer (the drawn keys are hidden in Tap and with a controller)
    if (dm_pad_menu_distance(self.geo, p) > 1) return NO;
    if (_tap || _padOff || (_layout.separated && !CGRectContainsPoint(_layout.controls, p))) return YES;
    return dm_pad_menu_takes(self.geo, _full, _layout.separated, p);
}
- (uint64_t)faceAt:(CGPoint)p {   // keys under the finger in the diamond (between two keys both count)
    uint64_t m = 0; CGFloat r = self.faceHitR;
    for (int b = B_A; b <= B_Y; b++) if (dist(p, [self facePos:b]) <= r) m |= 1ull << b;
    return m;
}
- (uint64_t)dpadAt:(CGPoint)p {   // 8 directions: 45° each, diagonals press two keys; a small centre circle counts as none
    CGPoint c = self.dpadCenter; CGFloat dx = p.x - c.x, dy = p.y - c.y;
    if (hypot(dx, dy) < self.dpadR * 0.25) return 0;
    double a = atan2(-dy, dx) * 180 / M_PI; uint64_t m = 0;
    if (a > -67.5 && a < 67.5) m |= 1ull << B_RIGHT;
    if (a > 22.5 && a < 157.5) m |= 1ull << B_UP;
    if (a > 112.5 || a < -112.5) m |= 1ull << B_LEFT;
    if (a < -22.5 && a > -157.5) m |= 1ull << B_DOWN;
    return m;
}
- (CGPoint)knobOffset:(int)i {   // knob offset from the stick centre (clamped to the stick radius)
    if (!_stick[i]) return CGPointZero;
    CGPoint h = [self stickCentre:i]; CGFloat dx = _stickNow[i].x - h.x, dy = _stickNow[i].y - h.y, d = hypot(dx, dy), R = [self stickR:i];
    if (d > R) { dx *= R / d; dy *= R / d; }
    return CGPointMake(dx, dy);
}

// ---- Touch ----
- (void)recompute {
    uint64_t face = 0; for (UITouch *t in _faceOf) face |= [_faceOf objectForKey:t].unsignedLongLongValue;
    uint64_t btn = _latched, dpad = 0;   // a toggled key stays pressed with no finger on it
    for (UITouch *t in _owner) { uint64_t v = [_owner objectForKey:t].unsignedLongLongValue; int c = (int)(v & 0xff);
        if (c == C_BTN) btn |= 1ull << (v >> 8);
        else if (c == C_DPAD) dpad |= [self dpadAt:[t locationInView:self]]; }
    int32_t ax[4] = {0};
    for (int i = 0; i < 2; i++) {
        CGPoint o = [self knobOffset:i]; CGFloat R = [self stickR:i], d = hypot(o.x, o.y), dz = R * K_DEAD;
        if (d <= dz) continue;
        CGFloat m = fmin((d - dz) / (R * K_FULL - dz), 1) / d;   // outside the dead zone: 0 rising to full at the full-tilt radius
        ax[i * 2] = (int32_t)lrint(o.x * m * 32767); ax[i * 2 + 1] = (int32_t)lrint(-o.y * m * 32767);   // host: up is positive; rounded so full tilt is exactly 32767
    }
    BOOL changed = face != _faceBits || dpad != _dpadBits || btn != _btnBits;
    uint64_t pressed = (face | dpad | btn) & ~(_faceBits | _dpadBits | _btnBits);
    unsigned gripping = (_stick[0] ? 1u : 0) | (_stick[1] ? 2u : 0);
    if (pressed || (gripping & ~_hapticSticks)) {
        [_touchFeedback impactOccurredWithIntensity:0.6]; [_touchFeedback prepare];
    }
    _hapticSticks = gripping;
    _faceBits = face; _dpadBits = dpad; _btnBits = btn;
    nx2ipa_virtual_pad(face | dpad | btn, ax[0] / 32767.f, ax[1] / 32767.f, ax[2] / 32767.f, ax[3] / 32767.f);
    BOOL stick = _stick[0] != nil;   // only the left stick is drawn: the right one needs no refresh
    if (changed || stick || _stickShown) [self refresh];   // also refresh on the stick release so the knob returns to the centre
    _stickShown = stick;
}
// Unclaimed touches use the actual nxkit picture rectangle, not an assumed 16:9 image.
- (void)pushGame {
    CGRect b = _layout.game;
    if (b.size.width <= 0 || b.size.height <= 0) { nx2ipa_touches(NULL, 0); return; }
    Nx2ipaTouch t[16]; int n = 0;
    for (int i = 0; i < 16; i++) if (_game[i]) {
        CGPoint p = dm_game_touch_point(b, [_game[i] locationInView:self]);   // stable finger slot, clamped only after capture
        t[n++] = (Nx2ipaTouch){(uint32_t)i, (float)p.x, (float)p.y};
    }
    nx2ipa_touches(t, n);
}
- (BOOL)gameBegin:(UITouch *)t {
    if (CGRectIsEmpty(_layout.game) || !CGRectContainsPoint(_layout.game, [t locationInView:self])) return NO;
    for (int i = 0; i < 16; i++) if (!_game[i]) { _game[i] = t; [_owner setObject:@(C_GAME | (uint64_t)i << 8) forKey:t]; return YES; }
    return NO;
}
- (BOOL)voiceOverRunning { return UIAccessibilityIsVoiceOverRunning(); }
- (BOOL)reduceMotionEnabled { return UIAccessibilityIsReduceMotionEnabled(); }
- (void)touchesBegan:(NSSet<UITouch *> *)ts withEvent:(UIEvent *)e {
    if (!_active || _menuOpen) return;
    if (_padOff && !_layout.onTV) [self wakeMenu];
    BOOL game = NO;
    for (UITouch *t in ts) {
        if (_padOff) { game |= [self gameBegin:t]; continue; }
        CGPoint p = [t locationInView:self];
        if (_layout.separated && !CGRectContainsPoint(_layout.controls, p)) { game |= [self gameBegin:t]; continue; }
        DmPadHit hit = dm_pad_hit(self.geo, _full, _layout.separated, _tap, !_stick[0], p);   // the same geometry the controls are drawn with (the menu button took its own touches, menuTakes)
        if (hit.kind == DM_PAD_HIT_KEY) {
            int key = lockedKey(hit.key);
            if (_toggle & (1ull << key)) { _latched ^= 1ull << key; [_owner setObject:@(C_NONE) forKey:t]; }   // a toggled key: this tap flips it, the finger holds nothing
            else [_owner setObject:@(C_BTN | (uint64_t)key << 8) forKey:t];
            continue;
        }
        if (_tap) { game |= [self gameBegin:t]; continue; }
        int kind = hit.kind == DM_PAD_HIT_FACE ? C_FACE : hit.kind == DM_PAD_HIT_DPAD ? C_DPAD : hit.kind == DM_PAD_HIT_STICK ? C_STICK : C_NONE, idx = 0;
        if (kind == C_NONE && _full && !_stick[1] && [self inRightArea:p]) { kind = C_STICK; idx = 1; _rCentre = p; [self hideHint]; }   // the right stick: centred where the touch lands (the hint's job is done)
        if (kind == C_FACE) { uint64_t keys = [self faceAt:p]; _latched ^= keys & _toggle;   // a toggled face key flips on touch-down, the held ones follow the finger
            [_owner setObject:@(C_FACE) forKey:t]; [_faceOf setObject:@(keys & ~_toggle) forKey:t]; }
        else if (kind == C_DPAD) [_owner setObject:@(C_DPAD) forKey:t];
        else if (kind == C_STICK) { [_owner setObject:@(C_STICK | (uint64_t)idx << 8) forKey:t]; _stick[idx] = t; _stickNow[idx] = p; }
        else game |= [self gameBegin:t];
    }
    if (game) [self pushGame];
    [self recompute];
}
- (void)touchesMoved:(NSSet<UITouch *> *)ts withEvent:(UIEvent *)e {
    if (!_active || _menuOpen) return;
    BOOL game = NO;
    for (UITouch *t in ts) {
        uint64_t v = [_owner objectForKey:t].unsignedLongLongValue; int c = (int)(v & 0xff); CGPoint p = [t locationInView:self];
        if (c == C_FACE) [_faceOf setObject:@([self faceAt:p] & ~_toggle) forKey:t];
        else if (c == C_STICK) { _stickNow[v >> 8] = p;
            if ((v >> 8) == 1) { CGFloat d = dist(p, _rCentre), R = [self stickR:1];   // the right stick's centre follows a finger past its radius, so turning back responds at once
                if (d > R) _rCentre = CGPointMake(p.x - (p.x - _rCentre.x) * R / d, p.y - (p.y - _rCentre.y) * R / d); } }
        else if (c == C_GAME) game = YES;
    }
    if (game) [self pushGame];
    [self recompute];
}
- (void)endTouches:(NSSet<UITouch *> *)ts tapped:(BOOL)ended {
    BOOL game = NO;
    for (UITouch *t in ts) {
        uint64_t v = [_owner objectForKey:t].unsignedLongLongValue;
        if ((v & 0xff) == C_GAME && (v >> 8) < 16) { _game[v >> 8] = nil; game = YES; }
        [_owner removeObjectForKey:t]; [_faceOf removeObjectForKey:t]; for (int i = 0; i < 2; i++) if (t == _stick[i]) _stick[i] = nil;
    }
    if (game) [self pushGame];
    [self recompute];
}
- (void)touchesEnded:(NSSet<UITouch *> *)ts withEvent:(UIEvent *)e { [self endTouches:ts tapped:YES]; }
- (void)touchesCancelled:(NSSet<UITouch *> *)ts withEvent:(UIEvent *)e { [self reset]; }
- (void)reset { _latched = 0; [_owner removeAllObjects]; [_faceOf removeAllObjects]; _stick[0] = _stick[1] = nil; for (int i = 0; i < 16; i++) _game[i] = nil; [self pushGame]; [self recompute]; }

// ---- Shapes ----
static CGPathRef circlePath(CGPoint c, CGFloat r) { return CGPathCreateWithEllipseInRect(CGRectMake(c.x - r, c.y - r, 2 * r, 2 * r), NULL); }
static CGPathRef dropPath(CGPoint c, CGFloat r, CGFloat tipAngle, CGFloat round) {   // teardrop: circle + two tangents meeting at the tip, tip slightly rounded
    CGFloat d = r * DM_PAD_DROP_TIP, th = acos(r / d);
    CGPoint tip = CGPointMake(c.x + d * cos(tipAngle), c.y + d * sin(tipAngle));
    CGPoint p1 = CGPointMake(c.x + r * cos(tipAngle + th), c.y + r * sin(tipAngle + th)), p2 = CGPointMake(c.x + r * cos(tipAngle - th), c.y + r * sin(tipAngle - th));
    CGMutablePathRef p = CGPathCreateMutable();
    CGPathMoveToPoint(p, NULL, p2.x, p2.y);
    CGPathAddArcToPoint(p, NULL, tip.x, tip.y, p1.x, p1.y, round);
    CGPathAddArc(p, NULL, c.x, c.y, r, tipAngle + th, tipAngle - th + 2 * M_PI, false);
    CGPathCloseSubpath(p); return p;
}
static CGPathRef armPath(CGPoint c, CGFloat R, CGFloat w, CGFloat in, CGFloat angle, CGFloat round) {   // one D-pad arm: an upward pentagon (tip toward the centre) rotated by angle around the centre
    CGPoint v[5] = {{-w, -R}, {w, -R}, {w, -(in + w)}, {0, -in}, {-w, -(in + w)}};
    CGFloat cs = cos(angle), sn = sin(angle);
    for (int i = 0; i < 5; i++) v[i] = CGPointMake(c.x + v[i].x * cs - v[i].y * sn, c.y + v[i].x * sn + v[i].y * cs);
    CGMutablePathRef p = CGPathCreateMutable();
    CGPathMoveToPoint(p, NULL, (v[4].x + v[0].x) / 2, (v[4].y + v[0].y) / 2);
    for (int i = 0; i < 5; i++) CGPathAddArcToPoint(p, NULL, v[i].x, v[i].y, v[(i + 1) % 5].x, v[(i + 1) % 5].y, round);
    CGPathCloseSubpath(p); return p;
}
static void setPath(CAShapeLayer *l, CGPathRef p) { l.path = p; l.shadowPath = p; CGPathRelease(p); }
static void placeLabel(CATextLayer *t, CGPoint c, CGFloat fs) {
    CTFontRef f = CTFontCreateUIFontForLanguage(kCTFontUIFontEmphasizedSystem, fs, NULL);
    t.font = f; t.fontSize = fs;
    CGFloat h = CTFontGetAscent(f) + CTFontGetDescent(f) + CTFontGetLeading(f), w = fs * 3;
    t.frame = CGRectMake(c.x - w / 2, c.y - h / 2, w, h);
    CFRelease(f);
}

- (void)layoutSubviews {
    [super layoutSubviews];
    // nxkit currently fills its drawable. Do not use nxnative's split/aspect-fit
    // picture rectangle unless the actual nxkit presenter reports an aspect.
    double aspect = nx2ipa_picture_aspect();
    CGRect game = aspect > 0 ? dm_aspect_fit(self.bounds, aspect) : self.bounds;
    [self arrange:(DmLayout){game, self.bounds, NO, NO, NO, NO}];
    CGFloat u = self.u;
    [CATransaction begin]; [CATransaction setDisableActions:YES];
    CGFloat scale = MAX(self.traitCollection.displayScale, 1);
    for (int b = 0; b < B_N; b++) if (_label[b] && _label[b].contentsScale != scale) {
        _label[b].contentsScale = scale; [_label[b] setNeedsDisplay];
    }
    _controls.frame = self.layer.bounds;
    for (int b = B_A; b <= B_Y; b++) { CGPoint c = [self facePos:b]; setPath(_key[b], circlePath(c, self.faceR)); placeLabel(_label[b], c, 20 * u); }
    for (int i = 0; i < (int)(sizeof k_btns / sizeof *k_btns); i++) { int b = k_btns[i];
        if (isDrop(b)) {
            BOOL right = b == B_ZR || b == B_R; CGPoint c = [self dropCenter:b];
            setPath(_key[b], dropPath(c, [self dropR:b], right ? -M_PI_4 : -3 * M_PI_4, 4 * u)); placeLabel(_label[b], c, 16 * u);   // tip toward the near top corner
        } else if (isClick(b)) {
            CGPoint c = [self clickCenter:b]; setPath(_key[b], circlePath(c, self.geo->clickR)); placeLabel(_label[b], c, 13 * u);
        } else {
            CGRect rc = [self pillRect:b];
            setPath(_key[b], CGPathCreateWithRoundedRect(rc, rc.size.height / 2, rc.size.height / 2, NULL)); placeLabel(_label[b], CGPointMake(CGRectGetMidX(rc), CGRectGetMidY(rc)), 18 * u);
        }
    }
    static const struct { int b; CGFloat angle; } arms[] = {{B_UP, 0}, {B_RIGHT, M_PI_2}, {B_DOWN, M_PI}, {B_LEFT, -M_PI_2}};   // the same arm in 90° steps
    for (int i = 0; i < 4; i++) setPath(_key[arms[i].b], armPath(self.dpadCenter, self.dpadR, self.geo->armW, self.geo->armIn, arms[i].angle, 6 * u));
    CGFloat mr = self.geo->swapR; CGPoint mc = self.menuCenter;
    _menu.frame = CGRectMake(mc.x - mr, mc.y - mr, 2 * mr, 2 * mr); _menu.layer.cornerRadius = mr;
    _menu.layer.shadowPath = [UIBezierPath bezierPathWithOvalInRect:_menu.bounds].CGPath;
    [_menu setImage:[UIImage systemImageNamed:@"gearshape.fill" withConfiguration:[UIImageSymbolConfiguration configurationWithPointSize:13 * u weight:UIImageSymbolWeightSemibold]] forState:UIControlStateNormal];
    setPath(_ring, circlePath(self.stickHome, [self stickR:0]));
    CGFloat k = self.geo->knobR; _knob.bounds = CGRectMake(0, 0, 2 * k, 2 * k);
    setPath(_knob, circlePath(CGPointMake(k, k), k));
    CAShapeLayer *in = (CAShapeLayer *)_knob.sublayers.firstObject; CGPathRef ip = circlePath(CGPointMake(k, k), k * 0.62);
    in.frame = _knob.bounds; in.path = ip; CGPathRelease(ip);
    [CATransaction commit];
    [self placeHint];
    [self refresh];
}

// ---- The right-stick hint ----
// The 3D layout's right stick is not drawn (it answers anywhere in the right third), and players read the layout as having none (GitHub issues #347, #414).
// So the first time the 3D layout shows in a launch, a few words say where it is, for two seconds, then fade. Words only: a ring or a knob would read as
// a fixed stick that has to be hit. It sits in the right third between the top row and the diamond, clear of every control (dm_pad_hint_rect); with no
// room, or with a controller connected, it waits. A touch on the right stick ends it at once. DM_TOUCH_HINT carries the words (the shell's language),
// empty turns it off; without it the words are English.
static BOOL g_hintShown;   // once per launch
- (void)placeHint {
    if (g_hintShown && _hint.hidden) return;
    if (!_full || _tap || _padOff || !_hintWords.length || CGRectIsEmpty(self.bounds)) { if (!_hint.hidden) [self hideHint]; return; }
    CGFloat u = self.u, fs = fmin(fmax(15 * u, 13), 20);
    UIFont *font = [UIFont systemFontOfSize:fs weight:UIFontWeightSemibold];
    CGSize t = [_hintWords sizeWithAttributes:@{NSFontAttributeName: font}];
    CGSize box = CGSizeMake(ceil(t.width) + 2 * fs, ceil(t.height) + fs * 0.8);
    CGRect area = _layout.controls;
    CGRect r = dm_pad_hint_rect(self.geo, CGRectGetMaxX(area) - area.size.width * K_RSWIPE, box);
    if (CGRectIsNull(r)) { if (!_hint.hidden) [self hideHint]; return; }
    [CATransaction begin]; [CATransaction setDisableActions:YES];
    _hint.frame = r; _hint.cornerRadius = box.height / 2;
    CTFontRef f = CTFontCreateUIFontForLanguage(kCTFontUIFontEmphasizedSystem, fs, NULL); _hintText.font = f; _hintText.fontSize = fs; CFRelease(f);
    _hintText.contentsScale = MAX(self.traitCollection.displayScale, 1);
    _hintText.frame = CGRectMake(0, (box.height - ceil(t.height)) / 2, box.width, ceil(t.height));
    [CATransaction commit];
    if (g_hintShown) return;   // already on screen: only follow the layout
    g_hintShown = YES;
    LOG("front end: right-stick hint shown");
    _hint.hidden = NO; _hint.opacity = 1;
    __weak Nx2ipaGamepad *weak = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [weak hideHint]; });
}
- (void)hideHint {
    if (_hint.hidden) return;
    [CATransaction begin]; [CATransaction setAnimationDuration:0.4];
    [CATransaction setCompletionBlock:^{ self->_hint.hidden = YES; }];
    _hint.opacity = 0;   // an implicit fade
    [CATransaction commit];
}
- (void)safeAreaInsetsDidChange { [super safeAreaInsetsDidChange]; [self reset]; _geoValid = NO; [self setNeedsLayout]; }
- (void)refresh {   // pressed state → fill, sticks → knob position
    uint64_t all = _faceBits | _dpadBits | _btnBits;
    [CATransaction begin]; [CATransaction setDisableActions:YES];
    for (int b = 0; b < B_N; b++) { BOOL on = (all >> b) & 1;
        _key[b].fillColor = (on ? k_on : k_idle).CGColor; _label[b].foregroundColor = (on ? k_textOn : k_text).CGColor; }
    CGPoint h = self.stickHome, o = [self knobOffset:0];
    _knob.position = CGPointMake(h.x + o.x, h.y + o.y); _knob.fillColor = (_stick[0] ? k_on : k_idle).CGColor;
    [CATransaction commit];
}

- (void)wakeMenu {
    unsigned gen = ++_menuGen;
    [_menu.layer removeAllAnimations];
    _menu.hidden = NO; _menu.alpha = 1;
    if (!_padOff || _layout.onTV || _menuOpen || [self voiceOverRunning]) return;
    __weak Nx2ipaGamepad *weak = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(K_MENU_IDLE * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        Nx2ipaGamepad *s = weak;
        if (!s || s->_menuGen != gen || !s->_padOff || s->_layout.onTV || s->_menuOpen || [s voiceOverRunning]) return;
        if ([s reduceMotionEnabled]) {
            s->_menu.alpha = 0; s->_menu.hidden = YES;
            return;
        }
        [UIView animateWithDuration:0.3 delay:0 options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction animations:^{
            s->_menu.alpha = 0;
        } completion:^(BOOL finished) {
            if (finished && s->_menuGen == gen && s->_padOff && !s->_layout.onTV && !s->_menuOpen && ![s voiceOverRunning]) s->_menu.hidden = YES;
        }];
    });
}
- (void)setMenuOpen:(BOOL)open {
    _menuOpen = open;
    if (open) [self reset];
    if (_padOff && !_layout.onTV) [self wakeMenu];
}
- (void)updateControlVisibility {
    _controls.hidden = _padOff;
    if (_padOff && _layout.onTV) {
        ++_menuGen; [_menu.layer removeAllAnimations];
        _menu.alpha = 1; _menu.hidden = YES;
    } else {
        [self wakeMenu];
    }
}
- (void)padsChanged:(NSNotification *)note {
    // Observe only. nxkit owns GameController handlers, slots, rumble and motion.
    // Refresh on the next main-loop turn after GameController updates its list.
    dispatch_async(dispatch_get_main_queue(), ^{ [self refreshControllers]; });
    // nxkit caches enumeration for 100 ms. Recheck after that bound so a fast
    // disconnect/reconnect cannot leave controls hidden until another event.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ [self refreshControllers]; });
}
- (void)refreshControllers {
    BOOL any = nx2ipa_has_controller();
    if (_padOff != any) { _padOff = any; [self reset]; }
    [self updateControlVisibility];
    [self setNeedsLayout];
}
- (void)setActive:(BOOL)active {
    _active = active;
    if (!active) { _menuOpen = NO; ++_menuGen; }
    self.userInteractionEnabled = active;
    [self reset];
    if (active) { [self opmodeChanged]; [self padsChanged:nil]; }
}
- (void)setSize:(int)size {
    [self reset];
    NSString *value = size == 0 ? @"small" : size == 2 ? @"large" : @"medium";
    [NSUserDefaults.standardUserDefaults setObject:value forKey:@"nx2ipa.pad.size"];
    _opts.scale = dm_pad_size_scale(value.UTF8String); _geoValid = NO; [self setNeedsLayout];
}
- (int)size { return _opts.scale < 1 ? 0 : _opts.scale > 1 ? 2 : 1; }
- (void)setStickPlace:(int)place {
    [self reset];
    NSString *value = place == 1 ? @"higher" : place == 2 ? @"inward" : @"corner";
    [NSUserDefaults.standardUserDefaults setObject:value forKey:@"nx2ipa.pad.stick"];
    _opts.stick = dm_pad_stick_place(value.UTF8String); _geoValid = NO; [self setNeedsLayout];
}
- (int)stickPlace { return _opts.stick; }
- (BOOL)feedback { return _touchFeedback != nil; }
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end

UIView *nx2ipa_overlay_create(CGRect frame) {
    Nx2ipaGamepad *view = [[Nx2ipaGamepad alloc] initWithFrame:frame];
    g_view = view; return view;
}
void nx2ipa_overlay_active(bool active) { [g_view setActive:active]; }
void nx2ipa_overlay_reset(void) { [g_view reset]; }
int nx2ipa_pad_layout(void) { return [g_view padLayout]; }
bool nx2ipa_pad_layout_offered(int layout) { return layout == 0 || layout == 1 || (layout == 2 && nx2ipa_is_handheld()); }
void nx2ipa_pad_layout_set(int layout) { if (nx2ipa_pad_layout_offered(layout)) [g_view setPadLayout:layout]; }
bool nx2ipa_pad_toggles(int control) { return control >= 0 && control < DM_PAD_C_N && ([g_view toggleMask] & (1u << control)); }
void nx2ipa_pad_toggle_set(int control, bool on) { [g_view setToggle:control on:on]; }
int nx2ipa_pad_size(void) { return [g_view size]; }
void nx2ipa_pad_size_set(int size) { if (size >= 0 && size <= 2) [g_view setSize:size]; }
int nx2ipa_pad_stick(void) { return [g_view stickPlace]; }
void nx2ipa_pad_stick_set(int place) { if (place >= 0 && place <= 2) [g_view setStickPlace:place]; }
bool nx2ipa_pad_feedback(void) { return [g_view feedback]; }
void nx2ipa_pad_feedback_set(bool on) {
    [NSUserDefaults.standardUserDefaults setBool:on forKey:@"nx2ipa.pad.feedback"];
    [g_view setTouchFeedback:on];
}
