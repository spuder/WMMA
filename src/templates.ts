/**
 * Category templates per entity type (SPEC §3). Leaves line up with tax form
 * lines so reports match the forms; WMMA does not file taxes. The line is
 * recorded on the account directive as a tag (e.g. `sch_c:21`). Accounts are
 * shared across entities: the business lives in the `entity` tag.
 */
import type { EntityType } from "./db";

export interface TemplateLine {
  account: string;
  /** Form line, e.g. "21" or "16a". */
  line?: string;
}

const pairs = (form: string, xs: Array<[string, string?]>): TemplateLine[] => xs.map(([account, line]) => ({ account, ...(line ? { line } : {}) }));

export const FORM_TAG: Record<EntityType, string | null> = {
  personal: null,
  schedule_c: "sch_c",
  s_corp_1120s: "f1120s",
  partnership_1065: "f1065",
  schedule_e: "sch_e",
};

export const TEMPLATES: Record<EntityType, TemplateLine[]> = {
  // Monarch's default categories (display names in ui/api.ts DISPLAY_NAMES). Account names are
  // never renamed once released: journals reference them.
  personal: pairs("", [
    // Income
    ["Income:Salary"],
    ["Income:Interest"],
    ["Income:Dividends"],
    ["Income:BusinessIncome"],
    ["Income:Other"],
    // Gifts & Donations
    ["Expenses:Charity"],
    ["Expenses:Gifts"],
    // Auto & Transport
    ["Expenses:Auto:Payment"],
    ["Expenses:Auto:PublicTransit"],
    ["Expenses:Auto:Gas"],
    ["Expenses:Auto:Maintenance"],
    ["Expenses:Auto:ParkingTolls"],
    ["Expenses:Auto:RideShare"],
    ["Expenses:Transportation"],
    // Housing
    ["Expenses:Housing:Mortgage"],
    ["Expenses:Housing:Rent"],
    ["Expenses:Housing:HomeImprovement"],
    // Bills & Utilities
    ["Expenses:Bills:Garbage"],
    ["Expenses:Bills:Water"],
    ["Expenses:Bills:GasElectric"],
    ["Expenses:Bills:InternetCable"],
    ["Expenses:Bills:Phone"],
    ["Expenses:Housing:Utilities"],
    ["Expenses:Subscriptions"],
    // Food & Dining
    ["Expenses:Food:Groceries"],
    ["Expenses:Food:Dining"],
    ["Expenses:Food:Coffee"],
    // Travel & Lifestyle
    ["Expenses:Travel"],
    ["Expenses:Entertainment"],
    ["Expenses:Personal"],
    ["Expenses:Pets"],
    ["Expenses:FunMoney"],
    // Shopping
    ["Expenses:Shopping"],
    ["Expenses:Clothing"],
    ["Expenses:FurnitureHousewares"],
    ["Expenses:Electronics"],
    // Children
    ["Expenses:Children:ChildCare"],
    ["Expenses:Children:Activities"],
    // Education
    ["Expenses:StudentLoans"],
    ["Expenses:Education"],
    // Health & Wellness
    ["Expenses:Healthcare"],
    ["Expenses:Dentist"],
    ["Expenses:Fitness"],
    // Financial
    ["Expenses:LoanRepayment"],
    ["Expenses:FinancialLegal"],
    ["Expenses:Fees"],
    ["Expenses:CashAtm"],
    ["Expenses:Insurance:Personal"],
    ["Expenses:Taxes:Personal"],
    // Other
    ["Expenses:Check"],
    ["Expenses:Miscellaneous"],
  ]),
  // Schedule C (Form 1040), Part I-II
  schedule_c: pairs("sch_c", [
    ["Income:GrossReceipts", "1"],
    ["Income:OtherBusiness", "6"],
    ["Expenses:CostOfGoodsSold", "4"],
    ["Expenses:Advertising", "8"],
    ["Expenses:CarTruck", "9"],
    ["Expenses:Commissions", "10"],
    ["Expenses:ContractLabor", "11"],
    ["Expenses:Depletion", "12"],
    ["Expenses:Depreciation", "13"],
    ["Expenses:EmployeeBenefits", "14"],
    ["Expenses:Insurance:Business", "15"],
    ["Expenses:Interest:Mortgage", "16a"],
    ["Expenses:Interest:Other", "16b"],
    ["Expenses:LegalProfessional", "17"],
    ["Expenses:Office", "18"],
    ["Expenses:PensionPlans", "19"],
    ["Expenses:Rent:Vehicles", "20a"],
    ["Expenses:Rent:Property", "20b"],
    ["Expenses:Repairs", "21"],
    ["Expenses:Supplies", "22"],
    ["Expenses:TaxesLicenses", "23"],
    ["Expenses:Travel:Business", "24a"],
    ["Expenses:Meals", "24b"],
    ["Expenses:Utilities", "25"],
    ["Expenses:Wages", "26"],
    ["Expenses:OtherBusiness", "27a"],
  ]),
  // Form 1120-S, page 1
  s_corp_1120s: pairs("f1120s", [
    ["Income:GrossReceipts", "1a"],
    ["Income:OtherBusiness", "5"],
    ["Expenses:CostOfGoodsSold", "2"],
    ["Expenses:OfficerCompensation", "7"],
    ["Expenses:Wages", "8"],
    ["Expenses:Repairs", "9"],
    ["Expenses:BadDebts", "10"],
    ["Expenses:Rent:Property", "11"],
    ["Expenses:TaxesLicenses", "12"],
    ["Expenses:Interest:Other", "13"],
    ["Expenses:Depreciation", "14"],
    ["Expenses:Depletion", "15"],
    ["Expenses:Advertising", "16"],
    ["Expenses:PensionPlans", "17"],
    ["Expenses:EmployeeBenefits", "18"],
    ["Expenses:OtherBusiness", "19"],
  ]),
  // Form 1065, page 1
  partnership_1065: pairs("f1065", [
    ["Income:GrossReceipts", "1a"],
    ["Income:OtherBusiness", "7"],
    ["Expenses:CostOfGoodsSold", "2"],
    ["Expenses:Wages", "9"],
    ["Expenses:GuaranteedPayments", "10"],
    ["Expenses:Repairs", "11"],
    ["Expenses:BadDebts", "12"],
    ["Expenses:Rent:Property", "13"],
    ["Expenses:TaxesLicenses", "14"],
    ["Expenses:Interest:Other", "15"],
    ["Expenses:Depreciation", "16a"],
    ["Expenses:Depletion", "17"],
    ["Expenses:PensionPlans", "18"],
    ["Expenses:EmployeeBenefits", "19"],
    ["Expenses:OtherBusiness", "21"],
  ]),
  // Schedule E (Form 1040), Part I
  schedule_e: pairs("sch_e", [
    ["Income:Rents", "3"],
    ["Income:Royalties", "4"],
    ["Expenses:Advertising", "5"],
    ["Expenses:AutoTravel", "6"],
    ["Expenses:CleaningMaintenance", "7"],
    ["Expenses:Commissions", "8"],
    ["Expenses:Insurance:Rental", "9"],
    ["Expenses:LegalProfessional", "10"],
    ["Expenses:ManagementFees", "11"],
    ["Expenses:Interest:Mortgage", "12"],
    ["Expenses:Interest:Other", "13"],
    ["Expenses:Repairs", "14"],
    ["Expenses:Supplies", "15"],
    ["Expenses:Taxes:Property", "16"],
    ["Expenses:Utilities", "17"],
    ["Expenses:Depreciation", "18"],
    ["Expenses:OtherRental", "19"],
  ]),
};

export function templateAccounts(type: EntityType): string[] {
  return TEMPLATES[type].map((l) => l.account);
}
