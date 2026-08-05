CREATE TABLE "scene" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text NOT NULL,
	"actions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scene_run" (
	"id" text PRIMARY KEY NOT NULL,
	"scene_id" text,
	"scene_name" text NOT NULL,
	"status" text NOT NULL,
	"resolved" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scene_run" ADD CONSTRAINT "scene_run_scene_id_scene_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scene"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scene_updated_at_idx" ON "scene" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "scene_run_started_at_idx" ON "scene_run" USING btree ("started_at");
--> statement-breakpoint
INSERT INTO "scene" ("id", "name", "description", "icon", "actions") VALUES
(
	'scene_explicit',
	'Explicit',
	'Red lights and an explicit playlist across the house.',
	'🔥',
	'[
		{"kind":"lighting","targets":[{"kind":"entity","entityId":"light.living_room_globe"},{"kind":"entity","entityId":"light.living_room_corner_lamp"},{"kind":"entity","entityId":"light.living_room_floor_lamp"},{"kind":"entity","entityId":"light.kitchen_lamp"},{"kind":"entity","entityId":"light.desk"},{"kind":"entity","entityId":"light.bed_lamp_left"},{"kind":"entity","entityId":"light.bed_lamp_right"},{"kind":"entity","entityId":"light.mirror"}],"power":true,"brightness":50,"color":{"kind":"rgb","red":255,"green":0,"blue":0},"transitionSeconds":2},
		{"kind":"music","source":{"kind":"spotify","playlists":[{"name":"Explicit","uri":"spotify:playlist:4p2s0B2eI2goKbj6CN20pV"}],"selection":"prompt","shuffleTracks":true},"outputs":[{"kind":"all","volume":30}]}
	]'::jsonb
),
(
	'scene_morning',
	'Morning',
	'Bright warm-white lights with light EDM.',
	'🌅',
	'[
		{"kind":"lighting","targets":[{"kind":"all"}],"power":true,"brightness":100,"color":{"kind":"temperature","kelvin":4000},"transitionSeconds":5},
		{"kind":"music","source":{"kind":"spotify","playlists":[{"name":"Light EDM","uri":"spotify:playlist:7aVilKgwoscbq0R36H0kuq"}],"selection":"fixed","shuffleTracks":true},"outputs":[{"kind":"all","volume":20}]}
	]'::jsonb
);
