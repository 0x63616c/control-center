/**
 * z-layers , what paints over what, in one place.
 *
 * The body-portalled surfaces (Settings, tile detail, ui/Modal, the PIN dialog)
 * had each picked the literal `100` independently, so their paint order was
 * decided by DOM insertion order , i.e. by which happened to mount last. It
 * renders correctly today and nothing states that it must; a surface that
 * mounts its portal earlier flips it, and the failure mode is a PIN dialog that
 * is invisible while still eating every keypress.
 *
 * A number here is only meaningful against its neighbours, so they are declared
 * together and read in order.
 */
export const Z_LAYER = {
  /** Full-surface overlays over the board: Settings, tile detail, ui/Modal. */
  pageOverlay: 100,

  /** Rides above a tile detail page it belongs to (tiles/views/VariantSwitcher). */
  variantSwitcher: 110,

  /** Notification stack. Inside #stage's stacking context, so this only orders
   *  it against its siblings there , it can never beat a body-level overlay. */
  notificationBanner: 120,

  /** The PIN dialog. Above every page overlay because it opens ON one and must
   *  never be the surface that is buried while still taking input. */
  pinDialog: 130,

  /** Idle lock's live blurred glass, below its PIN dialog but above pages. */
  lockScreen: 120,

  /** Panel-level modes that outrank ordinary UI: the level bubble, the
   *  screen-cleaning lockout, and the board's own gesture layer above them. */
  levelOverlay: 200,
  cleanScreenOverlay: 300,
  boardGestureLayer: 400,
} as const;
