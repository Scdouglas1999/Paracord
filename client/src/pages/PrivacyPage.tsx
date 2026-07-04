import { ShieldCheck } from 'lucide-react';
import { LegalDocument, type LegalSection } from './legal/LegalDocument';

const SECTIONS: LegalSection[] = [
  {
    id: 'overview',
    heading: 'Overview',
    body: [
      'Paracord is self-hosted software. This deployment is operated independently, and the server operator — not the Paracord project — is the party responsible for the data it holds and the policies that govern it.',
      'This page describes the kinds of data a Paracord server processes so you can make an informed decision before you register. For questions specific to this deployment, contact its operator directly.',
    ],
  },
  {
    id: 'data-we-store',
    heading: 'What data is stored',
    body: [
      'Account data includes your username, email address, profile metadata such as a display name and avatar, and the authentication records needed to keep your account secure.',
      'Messages, attachments, reactions, and moderation events are stored so the service can function — so your conversations persist, your files load, and moderators can act on abuse.',
      'Operational logs, including IP addresses and device information tied to sign-ins, are retained for a limited period to protect the server against abuse and to help diagnose problems.',
    ],
  },
  {
    id: 'how-data-is-used',
    heading: 'How your data is used',
    body: [
      'Data is used to deliver core functionality: authenticating you, routing messages, enforcing permissions, and moderating content. It is not sold, and this project ships no third-party advertising or analytics trackers.',
      'Server operators can access operational logs and moderation data strictly for abuse prevention, safety, and keeping the deployment running.',
    ],
  },
  {
    id: 'federation',
    heading: 'Federation and other servers',
    body: [
      'Paracord can federate with other servers. When you interact across a federation boundary — sending a message to a channel that spans servers, for example — the content and the identifiers needed to deliver it are shared with those peer servers.',
      'Each peer server is operated independently and applies its own policies to the data it receives. Review the peers your operator federates with if cross-server privacy matters to you.',
    ],
  },
  {
    id: 'your-controls',
    heading: 'Your controls',
    body: [
      'You can update your profile, change your email, and manage active sessions from your account settings at any time.',
      'End-to-end encryption protects the contents of supported conversations so that not even the server operator can read them. Metadata required to route messages is still processed.',
    ],
  },
  {
    id: 'retention-deletion',
    heading: 'Retention and deletion',
    body: [
      'You may request deletion of your account and associated data from the server operator. Once processed, your profile and messages are removed according to this deployment’s retention schedule.',
      'Some records — such as security logs or content preserved for an active moderation case — may be retained longer where the operator has a legitimate safety reason to keep them.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes to this policy',
    body: [
      'The operator of this deployment may revise these practices as the software and its configuration evolve. Material changes should be communicated through the server itself.',
    ],
  },
];

export function PrivacyPage() {
  return (
    <LegalDocument
      eyebrow="Privacy"
      icon={ShieldCheck}
      title="Privacy Policy"
      updated="July 2026"
      intro="This deployment is self-hosted, so data processing and retention are controlled by the server operator. Here is what a Paracord server collects and why."
      sections={SECTIONS}
    />
  );
}
