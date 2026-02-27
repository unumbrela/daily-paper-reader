import unittest

from src.subscription_plan import (
    build_pipeline_inputs,
    count_subscription_tags,
)


class SubscriptionPlanTest(unittest.TestCase):
    def test_build_pipeline_inputs_from_profiles(self):
        cfg = {
            'subscriptions': {
                'schema_migration': {'stage': 'A'},
                'intent_profiles': [
                    {
                        'id': 'p1',
                        'tag': 'SR',
                        'enabled': True,
                        'keywords': [
                            {
                                'id': 'k1',
                                'expr': 'A AND B',
                                'logic_cn': '需要同时满足 A 和 B',
                                'must_have': ['A'],
                                'optional': ['B'],
                                'exclude': ['C'],
                                'rewrite_for_embedding': 'A B',
                                'enabled': True,
                            }
                        ],
                        'semantic_queries': [
                            {
                                'id': 'q1',
                                'text': 'find papers about A and B',
                                'logic_cn': '语义补充',
                                'enabled': True,
                            }
                        ],
                    }
                ],
            }
        }

        plan = build_pipeline_inputs(cfg)
        self.assertEqual(plan['stage'], 'A')
        self.assertTrue(plan['bm25_queries'])
        self.assertTrue(plan['embedding_queries'])
        self.assertTrue(plan['context_keywords'])
        self.assertTrue(plan['context_queries'])

        kw_bm25 = [q for q in plan['bm25_queries'] if q.get('type') == 'keyword'][0]
        self.assertEqual(kw_bm25.get('boolean_expr'), '')
        self.assertEqual(kw_bm25.get('query_text'), 'A B')
        self.assertEqual(kw_bm25.get('paper_tag'), 'keyword:SR')

    def test_build_pipeline_inputs_without_profiles(self):
        plan = build_pipeline_inputs({'subscriptions': {'keyword_recall_mode': 'or'}})
        self.assertEqual(plan['stage'], 'A')
        self.assertEqual(plan['source'], 'intent_profiles_required_but_missing')
        self.assertEqual(plan['bm25_queries'], [])
        self.assertEqual(plan['embedding_queries'], [])
        self.assertEqual(plan['context_keywords'], [])
        self.assertEqual(plan['context_queries'], [])

    def test_build_pipeline_inputs_boolean_mixed_mode(self):
        cfg = {
            'subscriptions': {
                'keyword_recall_mode': 'boolean_mixed',
                'intent_profiles': [
                    {
                        'id': 'p1',
                        'tag': 'SR',
                        'enabled': True,
                        'keywords': [
                            {
                                'id': 'k1',
                                'expr': 'A AND B',
                                'enabled': True,
                            }
                        ],
                    }
                ],
            }
        }
        plan = build_pipeline_inputs(cfg)
        kw_bm25 = [q for q in plan['bm25_queries'] if q.get('type') == 'keyword'][0]
        self.assertEqual(kw_bm25.get('boolean_expr'), '')
        self.assertEqual(kw_bm25.get('query_text'), 'A B')

    def test_build_pipeline_inputs_backward_compatible_keyword_rules(self):
        cfg = {
            'subscriptions': {
                'intent_profiles': [
                    {
                        'id': 'p1',
                        'tag': 'SR',
                        'enabled': True,
                        'keyword_rules': [
                            {
                                'id': 'k1',
                                'expr': 'legacy expr',
                                'enabled': True,
                            }
                        ],
                    }
                ],
            }
        }
        plan = build_pipeline_inputs(cfg)
        kw_bm25 = [q for q in plan['bm25_queries'] if q.get('type') == 'keyword'][0]
        self.assertEqual(kw_bm25.get('query_text'), 'legacy expr')

    def test_count_tags(self):
        cfg = {
            'subscriptions': {
                'intent_profiles': [
                    {'id': 'p1', 'tag': 'A', 'enabled': True},
                    {'id': 'p2', 'tag': 'B', 'enabled': True},
                ]
            }
        }
        cnt, tags = count_subscription_tags(cfg)
        self.assertEqual(cnt, 2)
        self.assertIn('A', tags)
        self.assertIn('B', tags)


if __name__ == '__main__':
    unittest.main()
