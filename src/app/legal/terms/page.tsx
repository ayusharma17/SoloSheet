import Link from "next/link";

export const metadata = { title: "Terms of Service | SoloSheet" };

export default function TermsPage() {
  return (
    <>
      <header>
        <p className="text-sm font-bold uppercase tracking-widest text-[#e60000]">Legal</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-neutral-500">Effective September 17, 2026</p>
      </header>

      <section>
        <h2 className="text-xl font-bold">Using SoloSheet</h2>
        <p>
          SoloSheet converts documents you provide into AI-generated study aids. You must use the
          service lawfully, follow your school&apos;s academic-integrity and exam-material rules, and
          be old enough to consent to these terms where you live. Do not interfere with the service,
          bypass access or credit controls, or attempt to access another person&apos;s account or data.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Your content</h2>
        <p>
          You retain your rights in uploaded material. You represent that you have permission to
          upload and process it. You grant SoloSheet the limited permission needed to store,
          transmit, process, and delete that material to operate and secure the service. Do not
          upload confidential records, regulated data, or material you are not allowed to share.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">AI output and availability</h2>
        <p>
          AI output can be incomplete, inaccurate, or misleading. Review every cheat sheet against
          the source material before relying on it. SoloSheet does not guarantee academic results,
          uninterrupted availability, or that generated material will satisfy a particular exam&apos;s
          rules. Features and limits may change, and access may be suspended to protect users or the
          service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Purchases</h2>
        <p>
          Available credit packages, prices, and currency are shown before checkout. Stripe handles
          payment information. Credits are a limited license to request processing; they have no
          cash value and are not transferable. Refunds are provided where required by law or when
          separately agreed by the project operator.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Disclaimers and liability</h2>
        <p>
          To the extent permitted by law, the service is provided “as is” without warranties, and
          the project contributors are not liable for indirect, incidental, special, consequential,
          or punitive damages. Nothing here limits rights or liability that cannot legally be
          limited.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold">Changes and contact</h2>
        <p>
          Material changes will be posted here with a new effective date. For account or terms
          questions, use the maintainer contact method listed on the public project repository. See
          the <Link className="underline" href="/legal/privacy">Privacy Policy</Link> for data
          practices.
        </p>
      </section>
    </>
  );
}
