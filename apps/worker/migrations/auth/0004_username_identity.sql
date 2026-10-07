-- Build the case-insensitive constraint BEFORE changing any identity metadata.
-- If existing rows differ only by case, this statement fails without choosing a
-- winner, merging accounts, or rewriting usernames. Resolve such collisions by
-- explicitly renaming one account, preserving its ID/email/credentials/grants.
-- Preflight: SELECT lower(username), count(*) FROM user
-- GROUP BY lower(username) HAVING count(*) > 1
CREATE UNIQUE INDEX `user_username_normalized_unique` ON `user` (lower(`username`));--> statement-breakpoint
UPDATE `user` SET `username` = lower(`username`);
