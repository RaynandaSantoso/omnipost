import type { Metadata } from "next";
import { LegalPage } from "@/app/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy | OmniPost",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <section>
        <h2>Data OmniPost uses</h2>
        <p>When you connect a social platform, OmniPost may process:</p>
        <ul>
          <li>Basic account identifiers and display names.</li>
          <li>OAuth access and refresh tokens granted by the platform.</li>
          <li>Videos, titles, and descriptions you choose to upload.</li>
          <li>Upload status and error information.</li>
        </ul>
      </section>
      <section>
        <h2>How data is used</h2>
        <p>
          This data is used only to identify connected accounts, publish the
          content you request, display upload status, and refresh authorization
          when necessary.
        </p>
      </section>
      <section>
        <h2>Storage and sharing</h2>
        <p>
          OmniPost stores its application data on infrastructure controlled by
          its operator. OAuth tokens are encrypted at rest. Videos and related
          metadata are sent only to the platforms you select; OmniPost does not
          sell personal information.
        </p>
      </section>
      <section>
        <h2>Control and retention</h2>
        <p>
          Disconnecting a platform removes its stored connection tokens from
          OmniPost. Other locally stored uploads and history remain under the
          operator&apos;s control and retention practices.
        </p>
      </section>
    </LegalPage>
  );
}
