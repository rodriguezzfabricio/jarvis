---
name: <product name>
colors:
  primary: "<hex>"
  on-primary: "<hex>"
  surface: "<hex>"
  on-surface: "<hex>"
  muted: "<hex>"
  danger: "<hex>"
typography:
  display:
    fontFamily: "<typeface>"
    fontSize: "<size>"
    fontWeight: "<weight>"
    lineHeight: "<ratio>"
  body:
    fontFamily: "<typeface>"
    fontSize: "<size>"
    fontWeight: "<weight>"
    lineHeight: "<ratio>"
  label:
    fontFamily: "<typeface>"
    fontSize: "<size>"
    fontWeight: "<weight>"
    lineHeight: "<ratio>"
rounded:
  sm: "<px>"
  md: "<px>"
spacing:
  xs: "<px>"
  sm: "<px>"
  md: "<px>"
  lg: "<px>"
  xl: "<px>"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
---

# DESIGN.md: <product name>

<!-- The visual system (decision 51), in Google's DESIGN.md format: tokens in the YAML front matter,
     a short rationale per section below. The design skill fills it from the picked direction, or
     from the existing design system in the code. The token lint is the arbiter of the format.
     Replace every <…>; add or rename tokens as the direction needs, keeping the six groups.
     Components refer to tokens ({colors.primary}), never to raw values. Delete this comment when filled. -->

## Overview
<!-- The direction in two or three sentences, grounded in the product's world (decision 52). -->
- Direction: <name> (plan: .jarvis/mockups/<direction>/direction.md) | written from the existing design system (<paths>)
- Dials: layout variance <low|medium|high>, motion <low|medium|high>, density <low|medium|high>
- Picked by: user | default accepted | default unconfirmed (source: docs/intake/<file>, Q<n>)
- Principles: <2–3 principles that decide close calls>
- Theme code: generated from these tokens into <theme file>, starting with `--*: initial` so the default palette no longer exists; never edited by hand.

## Colors
<!-- Each color's job. One accent, tied to the primary action or a warning; tinted neutrals, never
     flat #000 or #111; the contrast ratios the lint checks. -->
- primary: <job>

## Typography
<!-- 1–2 typefaces and their roles, and why they fit the product's world. -->
- <typeface>: <role>

## Layout
<!-- The layout concept, the grid or column rules, the spacing scale and how density is set. -->
- <rule>

## Elevation & Depth
<!-- How layers are shown (shadow, border, tone), and where. Not one soft shadow on everything. -->
- <rule>

## Shapes
<!-- Corner radii and where each is used. Not one radius on everything. -->
- <rule>

## Components
<!-- The few components the main screens need, their states (empty, loading, error, offline,
     disabled, focus), and which one is the single primary action. -->
- <component>: <states and use>

## Do's and Don'ts
<!-- The direction's own rules, plus any tell from decision 53 that the brief asked for, quoting
     the brief. Write "none" when the brief asked for none. -->
- Tells the brief asks for: <none | the tell, with the brief's words>
- Do: <…>
- Don't: <…>
