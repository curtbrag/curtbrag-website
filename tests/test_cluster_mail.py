import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock

spec=importlib.util.spec_from_file_location('cluster_mail',Path(__file__).resolve().parents[1]/'scripts/cluster-mail.py')
mail=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class MailTests(unittest.TestCase):
    def setUp(self):
        self.config={'address':'unit@curtbrag.com','imap_password':'fixture-imap','smtp_username':'fixture-user','smtp_password':'fixture-smtp'}

    def test_unknown_action_rejected_before_connecting(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap:
            with self.assertRaises(ValueError):mail.run(self.config,{'action':'send','to':'stranger@example.com'})
            imap.assert_not_called()

    def test_self_test_ignores_external_recipient_and_preserves_readonly_inbox(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp:
            inbox=imap.return_value.__enter__.return_value
            inbox.noop.return_value=('OK',[])
            inbox.search.return_value=('OK',[b'123'])
            sender=smtp.return_value.__enter__.return_value
            sender.send_message.return_value={}
            result=mail.run(self.config,{'action':'test','id':'test-12345678','to':'stranger@example.com'})
            message=sender.send_message.call_args.args[0]
            self.assertEqual(message['To'],self.config['address'])
            self.assertEqual(message['From'],self.config['address'])
            self.assertTrue(result['delivery_verified'])
            inbox.select.assert_called_with('INBOX',readonly=True)
            sender.starttls.assert_called_once()
            self.assertNotIn('password',str(result))

    def test_check_does_not_open_or_read_inbox_or_send_mail(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp:
            inbox=imap.return_value.__enter__.return_value
            inbox.noop.return_value=('OK',[])
            mail.run(self.config,{'action':'check'})
            inbox.select.assert_not_called()
            inbox.fetch.assert_not_called()
            smtp.return_value.__enter__.return_value.send_message.assert_not_called()

    def test_delayed_confirmation_reads_only_exact_test_header_and_never_sends(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp:
            inbox=imap.return_value.__enter__.return_value
            inbox.noop.return_value=('OK',[])
            inbox.search.return_value=('OK',[b'456'])
            result=mail.run(self.config,{'action':'check','id':'test-12345678','verify_test':True})
            self.assertTrue(result['delivery_verified'])
            inbox.search.assert_called_with(None,'HEADER','Message-ID','"<fleet-test-12345678@curtbrag.com>"')
            inbox.fetch.assert_not_called()
            smtp.return_value.__enter__.return_value.send_message.assert_not_called()

    def test_imap_failure_after_send_preserves_acceptance_without_resending(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp:
            inbox=imap.return_value.__enter__.return_value
            inbox.noop.return_value=('OK',[])
            imap.side_effect=[imap.return_value,TimeoutError('must-not-leak-credential')]
            sender=smtp.return_value.__enter__.return_value
            sender.send_message.return_value={}
            result=mail.run(self.config,{'action':'test','id':'test-12345678'})
            self.assertTrue(result['accepted'])
            self.assertFalse(result['delivery_verified'])
            self.assertTrue(result['delivery_unconfirmed'])
            self.assertEqual(result['delivery_error'],'TimeoutError')
            self.assertNotIn('must-not-leak',str(result))
            sender.send_message.assert_called_once()

    def test_smtp_quit_failure_cannot_revoke_send_acceptance(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp, patch.object(mail.time,'sleep'):
            inbox=imap.return_value.__enter__.return_value
            inbox.noop.return_value=('OK',[])
            inbox.search.return_value=('OK',[b''])
            sender=smtp.return_value.__enter__.return_value
            sender.send_message.return_value={}
            smtp.return_value.__exit__.side_effect=OSError('must-not-leak-credential')
            result=mail.run(self.config,{'action':'test','id':'test-12345678'})
            self.assertTrue(result['accepted'])
            self.assertTrue(result['delivery_unconfirmed'])
            self.assertEqual(result['delivery_error'],'OSError')
            self.assertNotIn('must-not-leak',str(result))
            sender.send_message.assert_called_once()

    def test_receipt_can_confirm_send_after_smtp_quit_failure(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp:
            inbox=imap.return_value.__enter__.return_value
            inbox.noop.return_value=('OK',[])
            inbox.search.return_value=('OK',[b'456'])
            sender=smtp.return_value.__enter__.return_value
            sender.send_message.return_value={}
            smtp.return_value.__exit__.side_effect=OSError('quit failed')
            result=mail.run(self.config,{'action':'test','id':'test-12345678'})
            self.assertTrue(result['accepted'])
            self.assertTrue(result['delivery_verified'])
            self.assertFalse(result['delivery_unconfirmed'])
            sender.send_message.assert_called_once()

    def test_delivery_search_failure_retains_acceptance(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp:
            inbox=imap.return_value.__enter__.return_value
            inbox.noop.return_value=('OK',[])
            inbox.search.side_effect=mail.imaplib.IMAP4.abort('must-not-leak-credential')
            sender=smtp.return_value.__enter__.return_value
            sender.send_message.return_value={}
            result=mail.run(self.config,{'action':'test','id':'test-12345678'})
            self.assertTrue(result['accepted'])
            self.assertTrue(result['delivery_unconfirmed'])
            self.assertEqual(result['delivery_error'],'abort')
            self.assertNotIn('must-not-leak',str(result))
            sender.send_message.assert_called_once()

    def test_smtp_failure_before_acceptance_still_fails(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp:
            imap.return_value.__enter__.return_value.noop.return_value=('OK',[])
            sender=smtp.return_value.__enter__.return_value
            sender.login.side_effect=mail.smtplib.SMTPAuthenticationError(535,b'fixture')
            with self.assertRaises(mail.smtplib.SMTPAuthenticationError):
                mail.run(self.config,{'action':'test','id':'test-12345678'})
            sender.send_message.assert_not_called()

    def test_connection_check_quit_failure_still_fails_without_sending(self):
        with patch.object(mail.imaplib,'IMAP4_SSL') as imap, patch.object(mail.smtplib,'SMTP') as smtp:
            imap.return_value.__enter__.return_value.noop.return_value=('OK',[])
            smtp.return_value.__exit__.side_effect=OSError('quit failed')
            with self.assertRaises(OSError):mail.run(self.config,{'action':'check'})
            smtp.return_value.__enter__.return_value.send_message.assert_not_called()


if __name__=='__main__':unittest.main()
