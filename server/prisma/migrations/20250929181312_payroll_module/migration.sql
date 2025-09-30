-- CreateEnum
CREATE TYPE "PayrollAccrualMethod" AS ENUM ('NONE', 'MANUAL', 'MONTHLY_HOURS');

-- CreateEnum
CREATE TYPE "PayrollFactStatus" AS ENUM ('PENDING', 'FINALIZED');

-- CreateEnum
CREATE TYPE "PayrollBonusType" AS ENUM ('MONTHLY_ATTENDANCE', 'QUARTERLY_ATTENDANCE', 'KPI');

-- CreateEnum
CREATE TYPE "PayrollBonusStatus" AS ENUM ('PENDING', 'ELIGIBLE', 'APPROVED', 'DENIED', 'PAID');

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "PayrollCheckStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "PayrollAuditEvent" AS ENUM ('CONFIG_UPDATED', 'HOLIDAY_UPDATED', 'ATTENDANCE_RECALC', 'BONUS_DECISION', 'PAYROLL_STATUS_CHANGED');

-- CreateTable
CREATE TABLE "PayrollEmployeeConfig" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "effectiveOn" TIMESTAMP(3) NOT NULL,
    "baseSemiMonthlySalary" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "monthlyAttendanceBonus" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "quarterlyAttendanceBonus" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "kpiBonusDefaultAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "kpiBonusEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ptoBalanceHours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "nonPtoBalanceHours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "accrualEnabled" BOOLEAN NOT NULL DEFAULT false,
    "accrualMethod" "PayrollAccrualMethod" NOT NULL DEFAULT 'NONE',
    "accrualHoursPerMonth" DECIMAL(6,2),
    "notes" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollEmployeeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollEmployeeSchedule" (
    "id" SERIAL NOT NULL,
    "configId" INTEGER NOT NULL,
    "weekday" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "startMinutes" INTEGER,
    "endMinutes" INTEGER,
    "expectedHours" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollEmployeeSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollHoliday" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAttendanceFact" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "assignedHours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "workedHours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "ptoHours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "nonPtoAbsenceHours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "tardyMinutes" INTEGER NOT NULL DEFAULT 0,
    "matchedMakeUpHours" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "status" "PayrollFactStatus" NOT NULL DEFAULT 'PENDING',
    "isPerfect" BOOLEAN NOT NULL DEFAULT false,
    "finalizedAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "reasons" JSONB,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollAttendanceFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollBonus" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "PayrollBonusType" NOT NULL,
    "status" "PayrollBonusStatus" NOT NULL DEFAULT 'PENDING',
    "sourceMonth" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "approvedAmount" DECIMAL(10,2),
    "payableDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "decisionById" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "payrollCheckId" INTEGER,
    "attendanceFactId" INTEGER,
    "snapshot" JSONB,
    "quarterKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollBonus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" SERIAL NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payDate" TIMESTAMP(3) NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollCheck" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" "PayrollCheckStatus" NOT NULL DEFAULT 'DRAFT',
    "baseAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "monthlyAttendanceBonus" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deferredMonthlyBonus" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "quarterlyAttendanceBonus" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "kpiBonus" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "snapshot" JSONB,
    "notes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAuditLog" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER,
    "event" "PayrollAuditEvent" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEmployeeConfig_userId_effectiveOn_key" ON "PayrollEmployeeConfig"("userId", "effectiveOn");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEmployeeSchedule_configId_weekday_key" ON "PayrollEmployeeSchedule"("configId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollHoliday_date_key" ON "PayrollHoliday"("date");

-- CreateIndex
CREATE INDEX "PayrollAttendanceFact_status_idx" ON "PayrollAttendanceFact"("status");

-- CreateIndex
CREATE INDEX "PayrollAttendanceFact_month_idx" ON "PayrollAttendanceFact"("month");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollAttendanceFact_userId_month_key" ON "PayrollAttendanceFact"("userId", "month");

-- CreateIndex
CREATE INDEX "PayrollBonus_type_payableDate_idx" ON "PayrollBonus"("type", "payableDate");

-- CreateIndex
CREATE INDEX "PayrollBonus_status_idx" ON "PayrollBonus"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollBonus_userId_type_sourceMonth_key" ON "PayrollBonus"("userId", "type", "sourceMonth");

-- CreateIndex
CREATE INDEX "PayrollPeriod_payDate_idx" ON "PayrollPeriod"("payDate");

-- CreateIndex
CREATE INDEX "PayrollPeriod_status_idx" ON "PayrollPeriod"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_periodStart_periodEnd_key" ON "PayrollPeriod"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "PayrollCheck_status_idx" ON "PayrollCheck"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCheck_periodId_userId_key" ON "PayrollCheck"("periodId", "userId");

-- CreateIndex
CREATE INDEX "PayrollAuditLog_createdAt_idx" ON "PayrollAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "PayrollAuditLog_entityType_entityId_idx" ON "PayrollAuditLog"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "PayrollEmployeeConfig" ADD CONSTRAINT "PayrollEmployeeConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployeeConfig" ADD CONSTRAINT "PayrollEmployeeConfig_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployeeSchedule" ADD CONSTRAINT "PayrollEmployeeSchedule_configId_fkey" FOREIGN KEY ("configId") REFERENCES "PayrollEmployeeConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollHoliday" ADD CONSTRAINT "PayrollHoliday_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAttendanceFact" ADD CONSTRAINT "PayrollAttendanceFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollBonus" ADD CONSTRAINT "PayrollBonus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollBonus" ADD CONSTRAINT "PayrollBonus_decisionById_fkey" FOREIGN KEY ("decisionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollBonus" ADD CONSTRAINT "PayrollBonus_payrollCheckId_fkey" FOREIGN KEY ("payrollCheckId") REFERENCES "PayrollCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollBonus" ADD CONSTRAINT "PayrollBonus_attendanceFactId_fkey" FOREIGN KEY ("attendanceFactId") REFERENCES "PayrollAttendanceFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCheck" ADD CONSTRAINT "PayrollCheck_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCheck" ADD CONSTRAINT "PayrollCheck_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCheck" ADD CONSTRAINT "PayrollCheck_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCheck" ADD CONSTRAINT "PayrollCheck_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAuditLog" ADD CONSTRAINT "PayrollAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
