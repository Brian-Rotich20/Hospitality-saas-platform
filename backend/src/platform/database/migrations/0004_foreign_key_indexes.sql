CREATE INDEX "booking_events_actor_idx" ON "booking_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_reviewed_by_idx" ON "payment_attempts" USING btree ("reviewed_by");--> statement-breakpoint
CREATE INDEX "revenue_entries_vendor_idx" ON "revenue_entries" USING btree ("vendor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "revenue_entries_invoice_idx" ON "revenue_entries" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "subscription_invoices_plan_idx" ON "subscription_invoices" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "subscription_plans_created_by_idx" ON "subscription_plans" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "vendor_subscriptions_plan_idx" ON "vendor_subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "message_reports_reporter_idx" ON "message_reports" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "message_reports_resolved_by_idx" ON "message_reports" USING btree ("resolved_by");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_user_id");--> statement-breakpoint
CREATE INDEX "messages_hidden_by_idx" ON "messages" USING btree ("hidden_by");