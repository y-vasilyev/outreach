-- Per-account requests-per-minute caps for the worker-side role rate
-- limiter. NULL = use global env default (TG_PARSER_RPM /
-- TG_OUTREACH_RPM) or unlimited when env is also unset. Operators set
-- these per account from the inbox UI to throttle high-risk accounts.
ALTER TABLE "tg_account" ADD COLUMN "parser_rpm" INTEGER;
ALTER TABLE "tg_account" ADD COLUMN "outreach_rpm" INTEGER;
