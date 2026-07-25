CREATE TABLE "withings_oauth_token" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"withings_user_id" text NOT NULL,
	"last_meas_update" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weight_measurement" ADD COLUMN "withings_grpid" text;--> statement-breakpoint
ALTER TABLE "weight_measurement" ADD CONSTRAINT "weight_measurement_withings_grpid_unique" UNIQUE("withings_grpid");