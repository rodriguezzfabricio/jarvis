---
name: "Field Notes"
colors:
  primary: "#24543d"
  on-primary: "#ffffff"
  surface: "#f9f7f1"
  on-surface: "#202b26"
  muted: "#53635b"
  danger: "#a12622"
typography:
  display:
    fontFamily: "Fraunces"
    fontSize: "32px"
    fontWeight: "600"
    lineHeight: "1.2"
  body:
    fontFamily: "Atkinson Hyperlegible"
    fontSize: "16px"
    fontWeight: "400"
    lineHeight: "1.5"
  label:
    fontFamily: "Atkinson Hyperlegible"
    fontSize: "14px"
    fontWeight: "600"
    lineHeight: "1.4"
rounded:
  sm: "4px"
  md: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
---
# DESIGN.md: Field Notes
## Overview
Garden observations, written at the plot.
## Colors
Leaf green signals recording an observation.
## Typography
Fraunces titles; Atkinson Hyperlegible for observations.
## Layout
One chronological list with spacing from the scale.
## Elevation & Depth
Tone separates the editor.
## Shapes
Small corners on controls.
## Components
Record observation: idle, focus, loading, error, offline, disabled.
## Do's and Don'ts
Tells the brief asks for: none.
