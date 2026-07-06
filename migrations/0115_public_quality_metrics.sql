-- Opt-in public per-repo review-quality metrics (#2568). Default OFF — no public exposure until a maintainer enables it.
ALTER TABLE repository_settings ADD COLUMN public_quality_metrics INTEGER NOT NULL DEFAULT 0;
