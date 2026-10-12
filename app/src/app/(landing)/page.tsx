import LandingAnimations from "@/components/landing/LandingAnimations";
import Hero from "@/components/landing/sections/Hero";
import Features from "@/components/landing/sections/Features";
import WhyChooseUs from "@/components/landing/sections/WhyChooseUs";
import TakeCharge from "@/components/landing/sections/TakeCharge";
import Logos from "@/components/landing/sections/Logos";
import SendReceiveSwap from "@/components/landing/sections/SendReceiveSwap";
import Faq from "@/components/landing/sections/Faq";
import Cta from "@/components/landing/sections/Cta";
import Footer from "@/components/landing/sections/Footer";

export default function Landing() {
  return (
    <main id="landing">
      <Hero />
      <Features />
      <WhyChooseUs />
      <TakeCharge />
      <Logos />
      <SendReceiveSwap />
      <Faq />
      <Cta />
      <Footer />
      <LandingAnimations />
    </main>
  );
}
