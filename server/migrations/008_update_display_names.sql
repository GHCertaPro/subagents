-- 008_update_display_names.sql
-- Update bot display names to be human-readable.
UPDATE bot_tokens SET display_name = 'Puter' WHERE bot_id = 'cos' AND display_name = 'cos';
UPDATE bot_tokens SET display_name = 'Dispatch' WHERE bot_id = 'dispatch' AND display_name = 'dispatch';
