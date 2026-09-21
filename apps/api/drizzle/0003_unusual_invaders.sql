CREATE TABLE "user_keys" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"pubkey" text NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "custodial_pubkey" text;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_owner_id_users_wallet_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("wallet") ON DELETE cascade ON UPDATE no action;