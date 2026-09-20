-- AlterTable
ALTER TABLE "tailor_blueprints" ADD COLUMN     "provisioned_at" TIMESTAMP(3),
ADD COLUMN     "provisioned_path" TEXT,
ADD COLUMN     "provisioning_notes" TEXT,
ADD COLUMN     "provisioning_status" TEXT NOT NULL DEFAULT 'pending';

-- CreateIndex
CREATE INDEX "tailor_blueprints_provisioning_status_idx" ON "tailor_blueprints"("provisioning_status");
