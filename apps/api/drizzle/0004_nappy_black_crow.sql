CREATE TABLE "positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"mint" text NOT NULL,
	"symbol" text DEFAULT '' NOT NULL,
	"token_amount" bigint NOT NULL,
	"cost_micro" bigint DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"mint" text NOT NULL,
	"symbol" text DEFAULT '' NOT NULL,
	"usdc_micro" bigint DEFAULT 0 NOT NULL,
	"token_amount" bigint NOT NULL,
	"realized_pnl_micro" bigint DEFAULT 0 NOT NULL,
	"tx_sig" text
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "trade_realized_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "trade_volume_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "creator_reward_micro" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "token_mint" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "token_ticker" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "token_name" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "token_launched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "positions_agent_mint_uq" ON "positions" USING btree ("agent_id","mint");--> statement-breakpoint
CREATE INDEX "trades_agent_idx" ON "trades" USING btree ("agent_id","id");