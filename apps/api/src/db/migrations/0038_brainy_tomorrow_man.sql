CREATE TABLE "actual_injection" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" text NOT NULL,
	"vial_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"units" double precision NOT NULL,
	"planned_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "injection_check_in" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" text NOT NULL,
	"date" text NOT NULL,
	"values" jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"weight_id" text
);
--> statement-breakpoint
CREATE TABLE "injection_course" (
	"id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "injection_photo" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"pose" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"weight_id" text,
	"reference" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "injection_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "injection_vial" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" text NOT NULL,
	"label" text NOT NULL,
	"volume_ml" double precision NOT NULL,
	"concentration_mg_ml" double precision NOT NULL,
	"syringe_units_ml" double precision NOT NULL,
	"received_date" text,
	"opened_date" text,
	"discard_date" text,
	"retired" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actual_injection" ADD CONSTRAINT "actual_injection_course_id_injection_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."injection_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actual_injection" ADD CONSTRAINT "actual_injection_vial_id_injection_vial_id_fk" FOREIGN KEY ("vial_id") REFERENCES "public"."injection_vial"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injection_check_in" ADD CONSTRAINT "injection_check_in_course_id_injection_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."injection_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injection_photo" ADD CONSTRAINT "injection_photo_course_id_injection_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."injection_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injection_vial" ADD CONSTRAINT "injection_vial_course_id_injection_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."injection_course"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actual_injection_course_at_idx" ON "actual_injection" USING btree ("course_id","at");--> statement-breakpoint
CREATE INDEX "actual_injection_vial_idx" ON "actual_injection" USING btree ("vial_id");--> statement-breakpoint
CREATE UNIQUE INDEX "injection_check_in_day_idx" ON "injection_check_in" USING btree ("course_id","date");--> statement-breakpoint
CREATE INDEX "injection_photo_course_at_idx" ON "injection_photo" USING btree ("course_id","at");--> statement-breakpoint
CREATE INDEX "injection_vial_course_idx" ON "injection_vial" USING btree ("course_id");