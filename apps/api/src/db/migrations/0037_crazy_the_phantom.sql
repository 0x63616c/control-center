ALTER TABLE "weight_measurement" ADD COLUMN "manual_weight_kg" double precision;--> statement-breakpoint
ALTER TABLE "weight_measurement" ADD COLUMN "manual_body_metric_overrides" jsonb;