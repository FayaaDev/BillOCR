export const zohoRegions = {
  sa: { label: "Saudi", tokenUri: "https://accounts.zoho.sa/oauth/v2/token", apiDomain: "https://www.zohoapis.sa", sheetApi: "https://sheet.zoho.sa/api/v2", workdriveHost: "workdrive.zoho.sa", downloadApi: "https://files.zoho.sa/v1/workdrive/download" },
  us: { label: "US", tokenUri: "https://accounts.zoho.com/oauth/v2/token", apiDomain: "https://www.zohoapis.com", sheetApi: "https://sheet.zoho.com/api/v2", workdriveHost: "workdrive.zoho.com", downloadApi: "https://download.zoho.com/v1/workdrive/download" },
} as const;
export type ZohoRegion = keyof typeof zohoRegions;
export function readZohoRegion(value: unknown = "sa"): ZohoRegion {
  if (value !== "sa" && value !== "us") throw new Error("ZOHO_REGION must be sa or us");
  return value;
}
