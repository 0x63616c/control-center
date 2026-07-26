CREATE TABLE "incoming_webhook" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"repo" text,
	"sender_login" text,
	"subject_type" text,
	"subject_number" integer,
	"installation_id" text,
	"hook_id" text,
	"signature_valid" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "incoming_webhook_received_at_idx" ON "incoming_webhook" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "incoming_webhook_event_received_at_idx" ON "incoming_webhook" USING btree ("event","received_at");--> statement-breakpoint
CREATE INDEX "incoming_webhook_subject_idx" ON "incoming_webhook" USING btree ("subject_type","subject_number");