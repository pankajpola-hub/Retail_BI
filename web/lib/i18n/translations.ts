/**
 * Translations for store-facing UI.
 *
 * SCOPE: footfall entry, login, and navigation were the original translated
 * surface. Extended (2026-08) to cover the short instructional/label copy —
 * page titles, subtitles, section headings, empty-state and button text — on
 * every other screen too, so the language switcher visibly does something on
 * every page, not just footfall. The HO analytics dashboard's DENSE content
 * (network page: KPI grids, the footfall x conversion / traffic x sales
 * matrices, week-by-week tables, store league, agent tables, the long
 * "opportunity is an estimate" paragraph) is STILL deliberately NOT
 * translated — its audience is head-office staff working in English, and
 * half-translating dense analytical copy reads worse than leaving it
 * consistent. Same for the Targets page's day-by-day tracker table and the
 * Stock Details page's breakdown tables (owned by another workstream; not
 * touched here at all). Extend `Dict` and all non-English maps together when
 * scope changes — TypeScript will flag any key you miss.
 *
 * TRANSLATION QUALITY: natural, everyday Hindi/Marathi (the way store staff
 * actually talk), not stiff or Sanskritised. Common business/software words
 * that staff say in plain English on the shop floor — Store, Save, Target,
 * Bill(s), Sales, Units, Footfall, Conversion, Entry, Account, Link,
 * Password, Email, Optional, Campaign, Remarks, Sign In/Out — are kept as
 * literal English (Latin script), not translated and not transliterated
 * into Devanagari. Ordinary conversational Hindi/Marathi words that are
 * already natural and well understood (तारीख, नग, विक्री, नोंद, दुरुस्त
 * करतो, इत्यादी) are translated properly rather than anglicised. A native
 * speaker on your team should still review before rollout.
 */

export const LANGUAGES = ["en", "hi", "mr"] as const;
export type Lang = (typeof LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: "English",
  hi: "हिंदी",
  mr: "मराठी",
};

export type Dict = {
  // nav / shell
  appName: string;
  navNetwork: string;
  navFootfall: string;
  navReconciliation: string;
  navTargets: string;
  navUsers: string;
  navIntegrations: string;
  navDataUpload: string;
  navStockDetails: string;
  navStockStatus: string;
  navReplenishment: string;
  navSaleStockMix: string;
  navMovement: string;
  navWorkspace: string;
  navConfigurations: string;
  navEcomm: string;
  signOut: string;

  // login
  signIn: string;
  email: string;
  password: string;
  forgotPassword: string;
  sendResetLink: string;
  backToSignIn: string;
  or: string;
  continueWithGoogle: string;

  // footfall screen
  store: string;
  footfallTitle: string;
  footfallSubtitle: string;
  tabToday: string;
  tabAnotherDate: string;
  peopleEnteredToday: string;
  saving: string;
  saved: string;
  date: string;
  footfallLabel: string;
  remarks: string;
  remarksHint: string;
  save: string;
  saveAnyway: string;
  letMeFixIt: string;
  billsToday: string;
  conversion: string;
  salesPerVisitor: string;
  nonConvertingVisits: string;
  netSales: string;
  last14Days: string;
  daysMissing: string;
  notEntered: string;
  noStoreAssigned: string;
  enterWholeNumber: string;

  // login — error/notice banners
  errNotProvisioned: string;
  errAuthCallbackFailed: string;
  noticeResetEmailSent: string;

  // users (admin)
  usersTitle: string;
  usersSubtitle: string;
  addUserTitle: string;
  existingUsersTitle: string;
  noUsersYet: string;

  // data upload
  dataUploadTitle: string;
  dataUploadSubtitle: string;
  saleReportTitle: string;
  stockReportTitle: string;
  schemeReportTitle: string;
  downloadMergedSaleFile: string;
  download: string;
  noFilesUploadedYet: string;
  statusLabel: string;

  // targets (display-only copy — the tracker table itself stays English)
  targetsTitle: string;
  targetsSubtitle: string;
  incentiveTargetsTitle: string;
  incentiveTargetsSubtitle: string;
  uploadedFilesTitle: string;

  // integrations (admin)
  integrationsTitle: string;
  integrationsSubtitle: string;

  // configurations (admin)
  configurationsTitle: string;
  configurationsSubtitle: string;
  configFreshDiscSourceLabel: string;
  configFreshDiscSourceHint: string;
  configFreshDiscSourceRatio: string;
  configFreshDiscSourceRatioHint: string;
  configFreshDiscSourceScheme: string;
  configFreshDiscSourceSchemeHint: string;
  configSaveButton: string;
  configSavedNotice: string;

  // misc page titles
  myStoreTitle: string;
  campaignsTitle: string;
};

const en: Dict = {
  appName: "EBO Sales Intelligence",
  navNetwork: "Sales",
  navFootfall: "Footfall",
  navReconciliation: "Reconciliation",
  navTargets: "Targets",
  navUsers: "Users",
  navIntegrations: "Integrations",
  navDataUpload: "Data Upload",
  navStockDetails: "Stock Details",
  navStockStatus: "Stock Status",
  navReplenishment: "Replenishment",
  navSaleStockMix: "Sale vs Stock Mix",
  navMovement: "Movement",
  navWorkspace: "Workspace",
  navConfigurations: "Configurations",
  navEcomm: "Ecomm",
  signOut: "Sign out",

  signIn: "Sign in",
  email: "Email",
  password: "Password",
  forgotPassword: "Forgot password?",
  sendResetLink: "Send reset link",
  backToSignIn: "Back to sign in",
  or: "or",
  continueWithGoogle: "Continue with Google",

  store: "Store",
  footfallTitle: "Footfall",
  footfallSubtitle: "Sales, bills and units come from the ERP automatically. You only enter footfall.",
  tabToday: "Today",
  tabAnotherDate: "Another date",
  peopleEnteredToday: "People who entered today",
  saving: "Saving…",
  saved: "Saved",
  date: "Date",
  footfallLabel: "Footfall",
  remarks: "Remarks",
  remarksHint: "optional — e.g. festival, road closure, campaign day",
  save: "Save",
  saveAnyway: "Save anyway",
  letMeFixIt: "Let me fix it",
  billsToday: "Bills today",
  conversion: "Conversion",
  salesPerVisitor: "Sales / visitor",
  nonConvertingVisits: "Non-converting visits",
  netSales: "Net sales",
  last14Days: "Last 14 days",
  daysMissing: "days missing",
  notEntered: "not entered",
  noStoreAssigned: "No store assigned to this account yet.",
  enterWholeNumber: "Enter a whole number, 0 or more.",

  errNotProvisioned: "Your account isn't set up yet. Ask an HO admin to grant access.",
  errAuthCallbackFailed: "That link is invalid or has expired. Request a new one below.",
  noticeResetEmailSent: "If that email has an account, a reset link is on its way.",

  usersTitle: "Users",
  usersSubtitle:
    "New users are created here instantly, ready to sign in — no invite email is sent (SMTP isn't configured), so set their password below and share the account details with them yourself. Store access only matters for EBO Manager / Regional Manager; other roles ignore it.",
  addUserTitle: "Add user",
  existingUsersTitle: "Existing users",
  noUsersYet: "No users yet.",

  dataUploadTitle: "Data Upload",
  dataUploadSubtitle:
    "Offline mode while the live Logic ERP connection isn't available: upload the Sale, Stock and Scheme reports you already pull from Logic ERP by hand, then click Process on each file to load it into the dashboard. Stock and Scheme uploads REPLACE the previous snapshot; Sale uploads add to the running history. Restricted to HO Admin / Super Admin.",
  saleReportTitle: "Sale report",
  stockReportTitle: "Stock report",
  schemeReportTitle: "Scheme report",
  downloadMergedSaleFile: "Download merged sale file",
  download: "Download",
  noFilesUploadedYet: "No files uploaded yet.",
  statusLabel: "status",

  targetsTitle: "Targets",
  targetsSubtitle:
    "Monthly Fresh / Discounted unit targets, tracked day by day against actual sales — same structure as the tracker sheet EBO managers keep by hand. Actuals come straight from the ERP feed; only the two monthly targets are entered, one store/month at a time or in bulk via Excel below.",
  incentiveTargetsTitle: "Incentive targets",
  incentiveTargetsSubtitle:
    "Upload provision only, for now — files are stored and logged here, but day-wise qty/value target parsing and the incentive calculation itself aren't built yet. Restricted to HO Admin / Super Admin.",
  uploadedFilesTitle: "Uploaded files",

  integrationsTitle: "Integrations",
  integrationsSubtitle:
    "Connection details for external systems. Stored, not yet used — no part of this app connects to Logic ERP with these credentials today. Super Admin only.",

  configurationsTitle: "Configurations",
  configurationsSubtitle:
    "App-wide settings, editable by Super Admin only. More settings will be added here as later phases ship.",
  configFreshDiscSourceLabel: "Fresh / Discounted classification source",
  configFreshDiscSourceHint:
    "Decides how every sale line on the Targets Fresh/Discounted tracker and audit report is classified. Changing this changes numbers already on screen for every user — pick deliberately.",
  configFreshDiscSourceRatio: "Discount ratio (current default)",
  configFreshDiscSourceRatioHint: "Discounted when the line's discount is 49.5% or more of its gross amount.",
  configFreshDiscSourceScheme: "Scheme master",
  configFreshDiscSourceSchemeHint: "Discounted when the item's barcode is flagged in the uploaded Scheme report.",
  configSaveButton: "Save",
  configSavedNotice: "Saved.",

  myStoreTitle: "My store",
  campaignsTitle: "Campaigns",
};

const hi: Dict = {
  appName: "EBO Sales Intelligence",
  navNetwork: "Sales",
  navFootfall: "Footfall",
  navReconciliation: "Reconciliation",
  navTargets: "Targets",
  navUsers: "Users",
  navIntegrations: "Integrations",
  navDataUpload: "Data Upload",
  navStockDetails: "Stock Details",
  navStockStatus: "Stock Status",
  navReplenishment: "Replenishment",
  navSaleStockMix: "Sale vs Stock Mix",
  navMovement: "Movement",
  navWorkspace: "Workspace",
  navConfigurations: "Configurations",
  navEcomm: "Ecomm",
  signOut: "Sign Out",

  signIn: "Sign In करें",
  email: "Email",
  password: "Password",
  forgotPassword: "Password भूल गए?",
  sendResetLink: "Reset Link भेजें",
  backToSignIn: "Sign In पर वापस जाएँ",
  or: "या",
  continueWithGoogle: "Google से जारी रखें",

  store: "Store",
  footfallTitle: "Footfall",
  footfallSubtitle: "Sales, Bills और Units ERP से अपने आप आ जाते हैं। बस Footfall आपको भरनी है।",
  tabToday: "आज",
  tabAnotherDate: "अन्य तारीख",
  peopleEnteredToday: "आज का Footfall",
  saving: "Save हो रहा है…",
  saved: "Save हो गया",
  date: "तारीख",
  footfallLabel: "Footfall",
  remarks: "Remarks",
  remarksHint: "Optional — जैसे त्योहार, रास्ता बंद, या Campaign का दिन",
  save: "Save करें",
  saveAnyway: "फिर भी Save करें",
  letMeFixIt: "ठीक कर लेता हूँ",
  billsToday: "आज के Bills",
  conversion: "Conversion",
  salesPerVisitor: "प्रति ग्राहक Sales",
  nonConvertingVisits: "बिना खरीदारी किए ग्राहक",
  netSales: "Net Sales",
  last14Days: "पिछले 14 दिन",
  daysMissing: "दिन की Entry बाकी है",
  notEntered: "Entry नहीं हुई",
  noStoreAssigned: "इस Account से अभी कोई Store Link नहीं है।",
  enterWholeNumber: "पूरा नंबर डालें, 0 या उससे ज़्यादा।",

  errNotProvisioned: "आपका Account अभी सेट अप नहीं हुआ है। Access के लिए किसी HO Admin से कहें।",
  errAuthCallbackFailed: "यह Link गलत है या Expire हो चुका है। नीचे से नया Request करें।",
  noticeResetEmailSent: "अगर उस Email का Account है, तो Reset Link जल्द पहुँच जाएगा।",

  usersTitle: "Users",
  usersSubtitle:
    "नए Users यहीं तुरंत बनाए जाते हैं, Sign in के लिए तैयार — कोई Invite Email नहीं भेजा जाता (SMTP सेट नहीं है), इसलिए नीचे Password सेट करें और Details खुद User को दें। Store Access सिर्फ EBO Manager / Regional Manager के लिए मायने रखता है; बाकी Roles इसे इग्नोर करते हैं।",
  addUserTitle: "User जोड़ें",
  existingUsersTitle: "मौजूदा Users",
  noUsersYet: "अभी कोई User नहीं है।",

  dataUploadTitle: "Data Upload",
  dataUploadSubtitle:
    "जब तक Logic ERP का Live Connection उपलब्ध नहीं है, तब तक Offline Mode: Logic ERP से खुद निकाली गई Sale, Stock और Scheme Reports अपलोड करें, फिर हर फ़ाइल पर Process दबाकर Dashboard में लोड करें। Stock और Scheme Upload पिछला Snapshot REPLACE करते हैं; Sale Upload पुराने History में जुड़ता है। सिर्फ HO Admin / Super Admin के लिए।",
  saleReportTitle: "Sale Report",
  stockReportTitle: "Stock Report",
  schemeReportTitle: "Scheme Report",
  downloadMergedSaleFile: "Merged Sale File Download करें",
  download: "Download",
  noFilesUploadedYet: "अभी कोई फ़ाइल Upload नहीं हुई।",
  statusLabel: "Status",

  targetsTitle: "Targets",
  targetsSubtitle:
    "मासिक Fresh / Discounted Unit Targets, रोज़ाना Actual Sales के मुकाबले ट्रैक होते हैं — बिल्कुल उसी तरह जैसे EBO Managers अपनी Tracker Sheet हाथ से रखते हैं। Actuals सीधे ERP Feed से आते हैं; सिर्फ दो मासिक Targets भरने होते हैं, एक बार में एक Store/Month या नीचे Excel से Bulk में।",
  incentiveTargetsTitle: "Incentive Targets",
  incentiveTargetsSubtitle:
    "फ़िलहाल सिर्फ Upload की सुविधा है — फ़ाइलें यहाँ Store और Log होती हैं, पर Day-wise Qty/Value Target Parsing और Incentive Calculation अभी बना नहीं है। सिर्फ HO Admin / Super Admin के लिए।",
  uploadedFilesTitle: "Upload की गई फ़ाइलें",

  integrationsTitle: "Integrations",
  integrationsSubtitle:
    "बाहरी Systems की Connection Details। अभी सिर्फ Store की गई हैं, इस्तेमाल में नहीं — इस App का कोई हिस्सा अभी इन Credentials से Logic ERP से नहीं जुड़ता। सिर्फ Super Admin के लिए।",

  configurationsTitle: "Configurations",
  configurationsSubtitle: "App की Settings, सिर्फ Super Admin बदल सकते हैं। आगे और Settings यहाँ जुड़ेंगी।",
  configFreshDiscSourceLabel: "Fresh / Discounted तय करने का Source",
  configFreshDiscSourceHint:
    "Targets के Fresh/Discounted Tracker और Audit Report में हर Sale Line इसी से तय होती है। इसे बदलने से हर User को दिख रहे Numbers बदल जाएंगे — सोच-समझकर बदलें।",
  configFreshDiscSourceRatio: "Discount Ratio (अभी का Default)",
  configFreshDiscSourceRatioHint: "जब Line का Discount, Gross Amount के 49.5% या ज़्यादा हो तो Discounted।",
  configFreshDiscSourceScheme: "Scheme Master",
  configFreshDiscSourceSchemeHint: "जब Item का Barcode Upload किए गए Scheme Report में Flag हो तो Discounted।",
  configSaveButton: "Save करें",
  configSavedNotice: "Save हो गया।",

  myStoreTitle: "मेरा Store",
  campaignsTitle: "Campaigns",
};

const mr: Dict = {
  appName: "EBO Sales Intelligence",
  navNetwork: "Sales",
  navFootfall: "Footfall",
  navReconciliation: "Reconciliation",
  navTargets: "Targets",
  navUsers: "Users",
  navIntegrations: "Integrations",
  navDataUpload: "Data Upload",
  navStockDetails: "Stock Details",
  navStockStatus: "Stock Status",
  navReplenishment: "Replenishment",
  navSaleStockMix: "Sale vs Stock Mix",
  navMovement: "Movement",
  navWorkspace: "Workspace",
  navConfigurations: "Configurations",
  navEcomm: "Ecomm",
  signOut: "Sign Out",

  signIn: "Sign In करा",
  email: "Email",
  password: "Password",
  forgotPassword: "Password विसरलात?",
  sendResetLink: "Reset Link पाठवा",
  backToSignIn: "Sign In कडे परत जा",
  or: "किंवा",
  continueWithGoogle: "Google सह पुढे जा",

  store: "Store",
  footfallTitle: "Footfall",
  footfallSubtitle: "Sales, Bills आणि नग ERP मधून आपोआप येतात. तुम्हाला फक्त Footfall नोंदवायचं आहे.",
  tabToday: "आज",
  tabAnotherDate: "दुसरी तारीख",
  peopleEnteredToday: "आजचं Footfall",
  saving: "Save होत आहे…",
  saved: "Save झाले",
  date: "तारीख",
  footfallLabel: "Footfall",
  remarks: "Remarks",
  remarksHint: "Optional — उदा. सण, रस्ता बंद, किंवा Campaign चा दिवस",
  save: "Save करा",
  saveAnyway: "तरीही Save करा",
  letMeFixIt: "दुरुस्त करतो",
  billsToday: "आजची Bills",
  conversion: "Conversion",
  salesPerVisitor: "प्रति ग्राहक विक्री",
  nonConvertingVisits: "खरेदी न करता आलेले ग्राहक",
  netSales: "निव्वळ विक्री",
  last14Days: "मागील 14 दिवस",
  daysMissing: "दिवसांची नोंद बाकी आहे",
  notEntered: "नोंद नाही",
  noStoreAssigned: "या Account ला अजून कोणतेही Store जोडलेले नाही.",
  enterWholeNumber: "पूर्ण आकडा टाका, 0 किंवा त्याहून जास्त.",

  errNotProvisioned: "तुमचं Account अजून सेट अप झालेलं नाही. Access साठी एखाद्या HO Admin ला सांगा.",
  errAuthCallbackFailed: "हा Link चुकीचा आहे किंवा Expire झाला आहे. खाली नवीन Request करा.",
  noticeResetEmailSent: "त्या Email चं Account असेल तर Reset Link लवकरच पोहोचेल.",

  usersTitle: "Users",
  usersSubtitle:
    "नवीन Users इथेच लगेच तयार केले जातात, Sign in साठी तयार — कोणताही Invite Email पाठवला जात नाही (SMTP सेट केलेलं नाही), त्यामुळे खाली Password सेट करा आणि Details स्वतः User ला द्या. Store Access फक्त EBO Manager / Regional Manager साठी महत्त्वाचा आहे; इतर Roles तो दुर्लक्षित करतात.",
  addUserTitle: "User जोडा",
  existingUsersTitle: "सध्याचे Users",
  noUsersYet: "अजून कोणताही User नाही.",

  dataUploadTitle: "Data Upload",
  dataUploadSubtitle:
    "जोपर्यंत Logic ERP चं Live Connection उपलब्ध नाही, तोपर्यंत Offline Mode: Logic ERP मधून स्वतः काढलेले Sale, Stock आणि Scheme Reports अपलोड करा, मग प्रत्येक फाईलवर Process दाबून Dashboard मध्ये लोड करा. Stock आणि Scheme Upload आधीचा Snapshot REPLACE करतात; Sale Upload जुन्या History मध्ये जोडला जातो. फक्त HO Admin / Super Admin साठी.",
  saleReportTitle: "Sale Report",
  stockReportTitle: "Stock Report",
  schemeReportTitle: "Scheme Report",
  downloadMergedSaleFile: "Merged Sale File Download करा",
  download: "Download",
  noFilesUploadedYet: "अजून कोणतीही फाईल Upload झाली नाही.",
  statusLabel: "Status",

  targetsTitle: "Targets",
  targetsSubtitle:
    "मासिक Fresh / Discounted Unit Targets, रोजच्या Actual Sales विरुद्ध ट्रॅक होतात — EBO Managers जशी Tracker Sheet हाताने ठेवतात तशीच रचना. Actuals थेट ERP Feed मधून येतात; फक्त दोन मासिक Targets भरायची असतात, एका वेळी एक Store/Month किंवा खाली Excel वरून Bulk मध्ये.",
  incentiveTargetsTitle: "Incentive Targets",
  incentiveTargetsSubtitle:
    "सध्या फक्त Upload ची सोय आहे — फाईल्स इथे Store आणि Log होतात, पण Day-wise Qty/Value Target Parsing आणि Incentive Calculation अजून बनलेलं नाही. फक्त HO Admin / Super Admin साठी.",
  uploadedFilesTitle: "Upload केलेल्या फाईल्स",

  integrationsTitle: "Integrations",
  integrationsSubtitle:
    "बाहेरील Systems च्या Connection Details. सध्या फक्त Store केलेल्या आहेत, वापरात नाहीत — या App चा कोणताही भाग सध्या या Credentials नी Logic ERP शी जोडलेला नाही. फक्त Super Admin साठी.",

  configurationsTitle: "Configurations",
  configurationsSubtitle: "App च्या Settings, फक्त Super Admin बदलू शकतात. पुढे आणखी Settings इथे येतील.",
  configFreshDiscSourceLabel: "Fresh / Discounted ठरवण्याचा Source",
  configFreshDiscSourceHint:
    "Targets च्या Fresh/Discounted Tracker आणि Audit Report मधली प्रत्येक Sale Line यावरून ठरते. हे बदलल्यास प्रत्येक User ला दिसणारे Numbers बदलतील — विचारपूर्वक बदला.",
  configFreshDiscSourceRatio: "Discount Ratio (सध्याचा Default)",
  configFreshDiscSourceRatioHint: "जेव्हा Line चा Discount, Gross Amount च्या 49.5% किंवा जास्त असतो तेव्हा Discounted.",
  configFreshDiscSourceScheme: "Scheme Master",
  configFreshDiscSourceSchemeHint: "जेव्हा Item चा Barcode Upload केलेल्या Scheme Report मध्ये Flag असतो तेव्हा Discounted.",
  configSaveButton: "Save करा",
  configSavedNotice: "Save झालं.",

  myStoreTitle: "माझं Store",
  campaignsTitle: "Campaigns",
};

export const DICTIONARIES: Record<Lang, Dict> = { en, hi, mr };

export function isLang(value: string | undefined): value is Lang {
  return !!value && (LANGUAGES as readonly string[]).includes(value);
}
