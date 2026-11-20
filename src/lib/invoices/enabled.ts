/** Whether this deployment talks to an invoice service. The public pages say what invoices
 *  exist only when it does, so a copy that runs without the service (`docs/open-source.md`)
 *  never promises one. Read like `legalContactEmail()`: the env schema has already checked the
 *  value's shape at build and boot, and a page needs only whether it is set. */
export const invoicesEnabled = (): boolean => Boolean(process.env.INVOICE_SERVICE_URL?.trim());
