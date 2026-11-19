import subprocess
import unittest
from unittest.mock import Mock,patch

from agent.runtime import wait_for_xray_readiness,Runtime
from agent.reconciler import ReconcileError


class ReadinessRaceTests(unittest.TestCase):
    def clock(self):
        t=[0.0]
        def monotonic():return t[0]
        def sleep(seconds): t[0]+=seconds
        return t,monotonic,sleep

    def test_waits_for_three_ports_and_stats_before_success(self):
        ticks,clock,sleep=self.clock()
        with patch('agent.runtime.xray_pid',return_value=212), \
             patch('agent.runtime.ports_listening',side_effect=[False,False,True]), \
             patch('agent.runtime.stats_snapshot',return_value='{"stat":[]}') as stats:
            pid=wait_for_xray_readiness(timeout=4,interval=.25,
                monotonic=clock,sleep=sleep)
        self.assertEqual(pid,212)
        self.assertAlmostEqual(ticks[0],.5)
        stats.assert_called_once()

    def test_stats_endpoint_warms_up_later_than_tcp_listeners(self):
        ticks,clock,sleep=self.clock()
        with patch('agent.runtime.xray_pid',return_value=212), \
             patch('agent.runtime.ports_listening',return_value=True), \
             patch('agent.runtime.stats_snapshot',side_effect=[
                subprocess.CalledProcessError(1,['xray','api']),
                '{"stat":[]}']) as stats:
            self.assertEqual(wait_for_xray_readiness(timeout=4,
                monotonic=clock,sleep=sleep),212)
        self.assertAlmostEqual(ticks[0],.25)
        self.assertEqual(stats.call_count,2)

    def test_never_marks_ready_when_ports_are_missing(self):
        ticks,clock,sleep=self.clock()
        with patch('agent.runtime.xray_pid',return_value=212), \
             patch('agent.runtime.ports_listening',return_value=False), \
             patch('agent.runtime.stats_snapshot') as stats:
            with self.assertRaisesRegex(ReconcileError,'dual REALITY'):
                wait_for_xray_readiness(timeout=1,interval=.25,
                    monotonic=clock,sleep=sleep)
        self.assertAlmostEqual(ticks[0],1)
        stats.assert_not_called()

    def test_changed_pid_is_rejected_even_if_ports_listen(self):
        ticks,clock,sleep=self.clock()
        with patch('agent.runtime.xray_pid',side_effect=[212,213]), \
             patch('agent.runtime.ports_listening',return_value=True), \
             patch('agent.runtime.stats_snapshot',return_value='{"stat":[]}'):
            with self.assertRaisesRegex(ReconcileError,'unrecognized Xray process generation'):
                wait_for_xray_readiness(monotonic=clock,sleep=sleep)

    def test_malformed_stats_is_not_retried_or_accepted(self):
        ticks,clock,sleep=self.clock()
        with patch('agent.runtime.xray_pid',return_value=212), \
             patch('agent.runtime.ports_listening',return_value=True), \
             patch('agent.runtime.stats_snapshot',return_value='not-json') as stats:
            with self.assertRaises(ValueError):
                wait_for_xray_readiness(monotonic=clock,sleep=sleep)
        stats.assert_called_once()

    def test_apply_does_not_mark_installed_before_readiness_gate(self):
        import pathlib,tempfile,json
        with tempfile.TemporaryDirectory() as tmp:
            config=pathlib.Path(tmp)/'config.json'
            config.write_text(json.dumps({'inbounds':[]}))
            runtime=Runtime.__new__(Runtime)
            runtime.root=pathlib.Path(tmp)
            runtime.runner=Mock()
            # Force the service-inactive path so startup invalidates the old PID.
            runtime.runner.return_value.returncode=1
            ledger=Mock()
            active=[{'subscription_id':'sub-one','uuid':'unused'}]
            with patch('agent.runtime.compile_dual_account_config',
                 return_value={'inbounds':[]}), \
                 patch('agent.runtime.read_secret_file',return_value={}), \
                 patch('agent.runtime.wait_for_xray_readiness',
                       side_effect=ReconcileError('dual REALITY and stats listeners not active')) as ready:
                with self.assertRaisesRegex(ReconcileError,'dual REALITY'):
                    runtime.apply(ledger,active)
            ready.assert_called_once()
            ledger.mark_installed.assert_not_called()
            # The old process generation is invalidated after a fresh start,
            # but this must never activate a paid customer on failed readiness.
            ledger.epoch_reset.assert_called_once()


if __name__=='__main__':
    unittest.main()
