#pragma once
#include <stdbool.h>
#include "../../app/include/nx2ipa.h"
#ifdef __OBJC__
#import <UIKit/UIKit.h>
NS_ASSUME_NONNULL_BEGIN
// Main-thread only. The scene owns this view for the process-lifetime session.
UIView *nx2ipa_overlay_create(CGRect frame);
NS_ASSUME_NONNULL_END
#endif
void *nx2ipa_game_menu(void); // Swift returns a retained UIMenu.
void nx2ipa_overlay_active(bool active);
void nx2ipa_overlay_reset(void);
int nx2ipa_pad_layout(void);
bool nx2ipa_pad_layout_offered(int layout);
void nx2ipa_pad_layout_set(int layout);
bool nx2ipa_pad_toggles(int control);
void nx2ipa_pad_toggle_set(int control, bool on);
int nx2ipa_pad_size(void);
void nx2ipa_pad_size_set(int size);
int nx2ipa_pad_stick(void);
void nx2ipa_pad_stick_set(int place);
bool nx2ipa_pad_feedback(void);
void nx2ipa_pad_feedback_set(bool on);
