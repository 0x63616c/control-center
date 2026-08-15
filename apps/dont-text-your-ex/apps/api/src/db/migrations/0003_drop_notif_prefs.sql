-- Push-notification preferences removed from the product (no dispatch existed).
ALTER TABLE users DROP COLUMN IF EXISTS notif_prefs;
