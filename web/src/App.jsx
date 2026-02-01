import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout/Layout';
import Home from './pages/Home';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Hives from './pages/Hives';
import HiveDetail from './pages/HiveDetail';
import PostDetail from './pages/PostDetail';
import Forges from './pages/Forges';
import ForgeDetail from './pages/ForgeDetail';
import PatchDetail from './pages/PatchDetail';
import Knowledge from './pages/Knowledge';
import Bounties from './pages/Bounties';
import Analytics from './pages/Analytics';
import Admin from './pages/Admin';
import Login from './pages/Login';
import NotFound from './pages/NotFound';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="agents" element={<Agents />} />
        <Route path="agents/:id" element={<AgentDetail />} />
        <Route path="hives" element={<Hives />} />
        <Route path="hives/:name" element={<HiveDetail />} />
        <Route path="hives/:name/posts/:postId" element={<PostDetail />} />
        <Route path="forges" element={<Forges />} />
        <Route path="forges/:id" element={<ForgeDetail />} />
        <Route path="forges/:id/patches/:patchId" element={<PatchDetail />} />
        <Route path="knowledge" element={<Knowledge />} />
        <Route path="bounties" element={<Bounties />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
