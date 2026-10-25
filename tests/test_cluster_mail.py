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


if __name__=='__main__':unittest.main()
