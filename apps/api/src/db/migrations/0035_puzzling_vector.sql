CREATE TABLE "goal" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"encouragement" text,
	"kind" text NOT NULL,
	"target" integer,
	"reflective_prompts" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_checkin" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"day" date NOT NULL,
	"state" text NOT NULL,
	"value" integer,
	"reflection" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"effective_from" date NOT NULL,
	"kind" text NOT NULL,
	"weekdays" jsonb,
	"weekly_target" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_vacation" (
	"id" text PRIMARY KEY NOT NULL,
	"start_day" date NOT NULL,
	"end_day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goal_checkin" ADD CONSTRAINT "goal_checkin_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_schedule" ADD CONSTRAINT "goal_schedule_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_status_idx" ON "goal" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_checkin_goal_day_unique" ON "goal_checkin" USING btree ("goal_id","day");--> statement-breakpoint
CREATE INDEX "goal_checkin_day_idx" ON "goal_checkin" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_schedule_goal_effective_unique" ON "goal_schedule" USING btree ("goal_id","effective_from");--> statement-breakpoint
CREATE INDEX "goal_schedule_goal_effective_idx" ON "goal_schedule" USING btree ("goal_id","effective_from");--> statement-breakpoint
CREATE INDEX "goal_vacation_days_idx" ON "goal_vacation" USING btree ("start_day","end_day");