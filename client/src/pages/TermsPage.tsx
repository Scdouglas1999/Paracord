import { ScrollText } from 'lucide-react';
import { LegalDocument, type LegalSection } from './legal/LegalDocument';

const SECTIONS: LegalSection[] = [
  {
    id: 'overview',
    heading: 'Overview',
    body: [
      'These terms govern your use of this Paracord deployment. Paracord is self-hosted software; this server is run by an independent operator who sets the rules that apply on top of these baseline terms.',
      'By creating an account or using the service, you agree to these terms and to any additional community rules the operator publishes.',
    ],
  },
  {
    id: 'acceptable-use',
    heading: 'Acceptable use',
    body: [
      'Do not use the service for unlawful activity, harassment, abuse, or the distribution of malware. Do not attempt to disrupt the service, bypass moderation, or gain unauthorized access to other accounts or servers.',
      'Automated access — bots and integrations — must respect rate limits and the permissions granted to them. Abusive automation may be revoked without notice.',
    ],
  },
  {
    id: 'your-account',
    heading: 'Your account',
    body: [
      'You are responsible for activity performed with your account and for keeping your credentials and recovery material secure. Notify the operator promptly if you believe your account has been compromised.',
      'You must provide accurate registration information and keep your contact email current so account-security notices can reach you.',
    ],
  },
  {
    id: 'content-moderation',
    heading: 'Content and moderation',
    body: [
      'You retain ownership of the content you create. By posting, you grant this deployment the limited technical permissions needed to store and display your content to its intended audience.',
      'Server operators and their moderators may remove content, suspend accounts, or restrict access to enforce local rules or applicable law. Where a conversation is end-to-end encrypted, moderation relies on reports and metadata rather than message contents.',
    ],
  },
  {
    id: 'federation',
    heading: 'Federation',
    body: [
      'When you interact across federated servers, your content is delivered to and governed by those peer servers as well. Each peer applies its own terms and moderation. Consider this before sharing sensitive content across a federation boundary.',
    ],
  },
  {
    id: 'availability-backups',
    heading: 'Availability and backups',
    body: [
      'Availability is provided on a best-effort basis. The service may be unavailable for maintenance, upgrades, or reasons outside the operator’s control, and no specific uptime is guaranteed.',
      'Backups and data retention are managed by the server operator. Keep your own copies of anything you cannot afford to lose.',
    ],
  },
  {
    id: 'termination',
    heading: 'Termination',
    body: [
      'You may stop using the service and request account deletion at any time. The operator may suspend or terminate access for violations of these terms or the community rules.',
    ],
  },
  {
    id: 'changes',
    heading: 'Changes to these terms',
    body: [
      'These terms may be updated as the software and this deployment evolve. Continued use after a material change constitutes acceptance of the revised terms.',
    ],
  },
];

export function TermsPage() {
  return (
    <LegalDocument
      eyebrow="Legal"
      icon={ScrollText}
      title="Terms of Service"
      updated="July 2026"
      intro="These terms set the baseline responsibilities for people using this Paracord deployment and for the operator who runs it."
      sections={SECTIONS}
    />
  );
}
