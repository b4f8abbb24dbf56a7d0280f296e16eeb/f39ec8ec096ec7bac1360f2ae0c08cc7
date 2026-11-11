// Portable test-only CoreGraphics value shim. No Apple SDK or UI behavior implied.
#pragma once
#include <math.h>
#include <stdio.h>
#include <float.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#define NS_ASSUME_NONNULL_BEGIN
#define NS_ASSUME_NONNULL_END
#define _Nonnull
#ifndef M_PI_4
#define M_PI_4 0.78539816339744830962
#endif
#define _Nullable
#define YES true
#define NO false
#define MIN(a,b) ((a)<(b)?(a):(b))
#define MAX(a,b) ((a)>(b)?(a):(b))
#define CGFLOAT_MAX DBL_MAX
typedef bool BOOL;
typedef void UIView;
typedef double CGFloat;
typedef struct { double x, y; } CGPoint;
typedef struct { double width, height; } CGSize;
typedef struct { CGPoint origin; CGSize size; } CGRect;
typedef struct { double top, left, bottom, right; } UIEdgeInsets;
static const CGPoint CGPointZero = {0, 0};
static const CGRect CGRectZero = {{0, 0}, {0, 0}};
static const CGRect CGRectNull = {{INFINITY, INFINITY}, {0, 0}};
static const UIEdgeInsets UIEdgeInsetsZero = {0, 0, 0, 0};
static inline CGPoint CGPointMake(double x, double y) { return (CGPoint){x,y}; }
static inline CGSize CGSizeMake(double w, double h) { return (CGSize){w,h}; }
static inline CGRect CGRectMake(double x, double y, double w, double h) { return (CGRect){{x,y},{w,h}}; }
static inline double CGRectGetMinX(CGRect r) { return r.origin.x; }
static inline double CGRectGetMinY(CGRect r) { return r.origin.y; }
static inline double CGRectGetMaxX(CGRect r) { return r.origin.x+r.size.width; }
static inline double CGRectGetMaxY(CGRect r) { return r.origin.y+r.size.height; }
static inline double CGRectGetMidX(CGRect r) { return r.origin.x+r.size.width/2; }
static inline double CGRectGetMidY(CGRect r) { return r.origin.y+r.size.height/2; }
static inline bool CGRectIsNull(CGRect r) { return isinf(r.origin.x); }
static inline bool CGRectIsEmpty(CGRect r) { return CGRectIsNull(r)||r.size.width<=0||r.size.height<=0; }
static inline bool CGPointEqualToPoint(CGPoint a, CGPoint b) { return a.x==b.x&&a.y==b.y; }
static inline bool CGRectEqualToRect(CGRect a, CGRect b) { return CGPointEqualToPoint(a.origin,b.origin)&&a.size.width==b.size.width&&a.size.height==b.size.height; }
static inline bool CGRectContainsPoint(CGRect r, CGPoint p) { return !CGRectIsEmpty(r)&&p.x>=CGRectGetMinX(r)&&p.x<=CGRectGetMaxX(r)&&p.y>=CGRectGetMinY(r)&&p.y<=CGRectGetMaxY(r); }
static inline bool CGRectContainsRect(CGRect a, CGRect b) { return !CGRectIsNull(a)&&!CGRectIsNull(b)&&CGRectGetMinX(b)>=CGRectGetMinX(a)&&CGRectGetMaxX(b)<=CGRectGetMaxX(a)&&CGRectGetMinY(b)>=CGRectGetMinY(a)&&CGRectGetMaxY(b)<=CGRectGetMaxY(a); }
static inline CGRect CGRectInset(CGRect r, double x, double y) { return CGRectMake(r.origin.x+x,r.origin.y+y,r.size.width-2*x,r.size.height-2*y); }
static inline CGRect CGRectIntersection(CGRect a, CGRect b) {
    double x=MAX(CGRectGetMinX(a),CGRectGetMinX(b)), y=MAX(CGRectGetMinY(a),CGRectGetMinY(b));
    double w=MIN(CGRectGetMaxX(a),CGRectGetMaxX(b))-x, h=MIN(CGRectGetMaxY(a),CGRectGetMaxY(b))-y;
    return w<0||h<0 ? CGRectNull : CGRectMake(x,y,w,h);
}
static inline bool CGRectIntersectsRect(CGRect a, CGRect b) { return !CGRectIsEmpty(CGRectIntersection(a,b)); }
static inline UIEdgeInsets UIEdgeInsetsMake(double t,double l,double b,double r) { return (UIEdgeInsets){t,l,b,r}; }
static inline CGRect UIEdgeInsetsInsetRect(CGRect r, UIEdgeInsets i) { return CGRectMake(r.origin.x+i.left,r.origin.y+i.top,r.size.width-i.left-i.right,r.size.height-i.top-i.bottom); }
