ALTER TABLE `user` ADD `access_actor` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `username` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `user_access_actor_unique` ON `user` (`access_actor`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);