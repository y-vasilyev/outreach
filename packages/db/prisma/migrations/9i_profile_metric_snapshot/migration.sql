-- blogger-dynamics: numeric-metric time series for profile trends.
-- One row per observed CHANGE of a rolled-up numeric metric (avgViews, reach,
-- subscribers:<platform>). Price/CPM history is NOT duplicated here — the
-- placement_offer superseded chains already form a complete price series.

-- CreateTable
CREATE TABLE "profile_metric_snapshot" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'rollup',

    CONSTRAINT "profile_metric_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_metric_snapshot_profile_id_metric_captured_at_idx"
    ON "profile_metric_snapshot"("profile_id", "metric", "captured_at");

-- AddForeignKey
ALTER TABLE "profile_metric_snapshot"
    ADD CONSTRAINT "profile_metric_snapshot_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "blogger_profile"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
