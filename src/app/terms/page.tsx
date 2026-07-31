import type { Metadata } from "next";
import { LegalPage } from "@/app/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service | OmniPost",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <section>
        <h2>Purpose</h2>
        <p>
          OmniPost is a private, self-hosted tool for sending videos to social
          platforms selected by its operator. It is provided for personal use
          and testing.
        </p>
      </section>
      <section>
        <h2>Acceptable use</h2>
        <p>By using OmniPost, you agree to:</p>
        <ul>
          <li>Upload only content you own or have permission to publish.</li>
          <li>Follow the rules and terms of each connected platform.</li>
          <li>Not use the service for unlawful, abusive, or deceptive activity.</li>
        </ul>
      </section>
      <section>
        <h2>Third-party platforms</h2>
        <p>
          Publishing through OmniPost is also governed by the terms, privacy
          policies, availability, and technical limits of the selected social
          platforms. OmniPost does not control those services.
        </p>
      </section>
      <section>
        <h2>No warranty</h2>
        <p>
          OmniPost is provided as-is for private use. Posting may fail or be
          delayed because of network conditions, platform restrictions, or
          changes to third-party APIs.
        </p>
      </section>
    </LegalPage>
  );
}
