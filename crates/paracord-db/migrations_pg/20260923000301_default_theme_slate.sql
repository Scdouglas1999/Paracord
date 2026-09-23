-- Slate replaces the purple "voices" look as the default (2026-09-22).
-- Voices was the default only from 3.1.0 (2026-09-20), and saving any setting
-- wrote the default theme into the row, so a stored 'voices' mostly means
-- "never chose". Move those accounts to Slate; the purple look stays available
-- in Settings as "Aubergine" for anyone who wants it back.
UPDATE user_settings SET theme = 'slate' WHERE theme = 'voices';
