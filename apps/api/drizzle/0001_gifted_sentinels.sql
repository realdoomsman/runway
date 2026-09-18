ALTER TABLE "agents" ADD COLUMN "revenue_pending_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_live_per_owner_uq" ON "agents" USING btree ("owner_wallet") WHERE status <> 'dead';--> statement-breakpoint
CREATE UNIQUE INDEX "bounties_escrow_tx_uq" ON "bounties" USING btree ("escrow_tx");