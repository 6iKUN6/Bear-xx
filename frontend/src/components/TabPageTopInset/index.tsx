import NavBar from "../NavBar";

interface TabPageTopInsetProps {
  className?: string;
}

export default function TabPageTopInset({
  className = "",
}: TabPageTopInsetProps) {
  return (
    <NavBar
      title={null}
      showBack={false}
      variant='ghost'
      capsule='hidden'
      className={`shrink-0 ${className}`.trim()}
      barClassName='px-[0rem]'
    />
  );
}
