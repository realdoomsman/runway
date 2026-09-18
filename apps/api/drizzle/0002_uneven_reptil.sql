CREATE TABLE "purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'spawn' NOT NULL,
	"path" text DEFAULT 'deposit' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_polled_at" timestamp with time zone,
	"deposit_pubkey" text NOT NULL,
	"deposit_secret_enc" "bytea",
	"deposit_iv" "bytea",
	"deposit_tag" "bytea",
	"claim_code_hash" text,
	"owner_wallet" text,
	"owner_id" text,
	"quoted_micro" bigint NOT NULL,
	"amount_micro" bigint DEFAULT 0 NOT NULL,
	"usdc_micro" bigint DEFAULT 0 NOT NULL,
	"sol_lamports" bigint DEFAULT 0 NOT NULL,
	"sol_value_micro" bigint DEFAULT 0 NOT NULL,
	"sol_price_usd" numeric(14, 4) DEFAULT 0 NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_micro" bigint DEFAULT 0 NOT NULL,
	"funding_micro" bigint DEFAULT 0 NOT NULL,
	"quoted_tier" text NOT NULL,
	"tier" text,
	"pace" text DEFAULT 'steady' NOT NULL,
	"heartbeat_min" integer,
	"model" text,
	"effort" text,
	"agent_name" text,
	"directive" text,
	"tools" jsonb,
	"fork_of" text,
	"topup_agent_id" text,
	"agent_id" text,
	"sweep_sig" text,
	"funding_sig" text,
	"refund_to" text,
	"refund_sig" text,
	"spawn_error" text,
	"spawn_attempts" integer DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "seed_micro" TO "funding_micro";--> statement-breakpoint
DROP INDEX "agents_one_live_per_owner_uq";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "heartbeat_min" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_kind" text DEFAULT 'wallet' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "purchase_id" text;--> statement-breakpoint
ALTER TABLE "pool" ADD COLUMN "agents_funded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pool" ADD COLUMN "funded_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pool" ADD COLUMN "purchases_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pool" ADD COLUMN "founder_fees_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pool_txs" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'wallet' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "payout_wallet" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purchase_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_fork_of_agents_id_fk" FOREIGN KEY ("fork_of") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_topup_agent_id_agents_id_fk" FOREIGN KEY ("topup_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_deposit_pubkey_uq" ON "purchases" USING btree ("deposit_pubkey");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_claim_code_uq" ON "purchases" USING btree ("claim_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_name_reserved_uq" ON "purchases" USING btree ("agent_name") WHERE status in ('pending','received');--> statement-breakpoint
CREATE INDEX "purchases_status_idx" ON "purchases" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "purchases_owner_idx" ON "purchases" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "purchases_agent_idx" ON "purchases" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_purchase_idx" ON "agents" USING btree ("purchase_id");--> statement-breakpoint
ALTER TABLE "pool" DROP COLUMN "seeds_paid";--> statement-breakpoint
ALTER TABLE "pool" DROP COLUMN "seeds_paid_micro";--> statement-breakpoint
ALTER TABLE "pool" DROP COLUMN "fee_claims_micro";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "runway_balance";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "runway_checked_at";