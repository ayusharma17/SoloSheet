import Link from "next/link";

export const metadata = { title: "Privacy Policy | SoloSheet" };

export default function PrivacyPage() {
  return (
    <>
      <header>
        <p className="text-sm font-bold uppercase tracking-widest text-[#e60000]">Legal</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-neutral-500">Effective September 17, 2026</p>
      </header>

      <section>
        <h2 className="text-xl font-bold">Data SoloSheet processes</h2>
        <p>
          SoloSheet processes your sign-in identity and email, account and credit state, uploaded
          PDFs or images, extraction instructions, generated cheat-sheet content, and operational
          records needed for security and reliability. When you purchase credits, SoloSheet stores
          transaction identifiers, status, amount, and currency, but Stripe—not SoloSheet—collects
          your full card details.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">How data is used and shared</h2>
        <p>
          Data is used to authenticate you, generate and save cheat sheets, process payments,
          prevent abuse, troubleshoot failures, and operate the service. Google provides sign-in,
          Supabase provides authentication, database, and temporary file storage, Google Gemini
          processes uploaded content and instructions, Stripe processes payments, and the hosting
          provider serves the application. Data is shared with these providers only as needed for
          those functions or when required by law.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Storage and retention</h2>
        <p>
          Uploaded source files are intended to be temporary and are deleted through the storage
          service after completed processing; failed or interrupted requests may retain a file until
          automated or operational cleanup succeeds. Generated cheat sheets, account records, credit
          transactions, security audit records, and legally required payment records may remain
          while your account is active or as needed for security, dispute handling, and legal
          obligations. Do not upload sensitive personal information that is unnecessary for a study
          aid.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Cookies and security</h2>
        <p>
          SoloSheet uses authentication cookies required to keep you signed in. The application
          does not currently include advertising cookies. Reasonable technical controls are used,
          but no online service can guarantee absolute security.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Your choices</h2>
        <p>
          You can choose not to upload a document or purchase credits. To request access,
          correction, or deletion of account data, use the maintainer contact method listed on the
          public project repository. Some transaction or security records may be retained where
          legally required or necessary to protect the service. Depending on where you live, you may
          have additional privacy rights.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Changes and contact</h2>
        <p>
          Material changes will be posted here with a new effective date. For privacy questions, use
          the maintainer contact method listed on the public project repository. Also review the{" "}
          <Link className="underline" href="/legal/terms">Terms of Service</Link>.
        </p>
      </section>
    </>
  );
}
